"""Local MLX speech-to-text worker for OpenCode dictation.

Reads one JSON request per line on stdin and writes one JSON reply per line on stdout:

  {"id": 1, "op": "load"}                                        -> {"id": 1, "model": "..."}
  {"id": 2, "op": "transcribe", "session": "s", "audio": "<b64>", "final": false} -> {"id": 2, "text": "...", "committed": "..."}
  {"id": 3, "op": "cancel", "session": "s"}                       -> {"id": 3}
  {"id": 4, "op": "languages"}                                   -> {"id": 4, "languages": ["Japanese", ...]}

`audio` is little-endian 16-bit mono PCM at 16 kHz, appended to the session's buffer. Each transcribe returns the
transcript of everything the session has heard so far, and `committed`, the start of it that later audio no longer
changes; `final` ends the session. Failures reply {"id", "error"}.
Speech is found with a VAD and cut into phrases at pauses; a turn model holds the cut while a sentence sounds
unfinished. The fast model writes the languages it knows. Where it may have spelled out a registered term, the main
model, which follows the hotwords, rewrites that phrase if it hears the term; it writes every other language.
Libraries may print to stdout, so replies go to the original stdout and everything else to stderr.
"""

import base64
import json
import os
import re
import sys
import traceback

import numpy as np

RATE = 16000
# Silero VAD scores 32 ms frames; segments are kept and cut in whole frames.
FRAME = 512
VAD_MODEL = "mlx-community/silero-vad"
# A frame is speech when the VAD is at least this sure. A segment without speech is never decoded, which stops the
# model from inventing text on silence. The VAD hears quiet microphones that a loudness threshold would drop.
SPEECH = 0.5
# Audio this quiet (about -70 dBFS) is silence without asking the VAD.
SILENT_RMS = 0.0003
# A segment longer than this is committed at its least speech-like point, so a long dictation never re-decodes minutes
# of audio.
SEGMENT_MAX = RATE * 20
SEGMENT_SEARCH = RATE * 6 // FRAME
# Partial passes wait for this much audio; a fraction of a word decodes into guesses that flicker in the prompt.
PARTIAL_MIN = RATE // 2
# A pause this long after speech commits the segment, so each partial pass re-decodes only the current phrase.
PAUSE_FRAMES = RATE // 2 // FRAME
# With a turn model, a pause commits only once the model hears a finished sentence, or once it lasts this long.
TURN_MODEL = os.environ.get("OPENCODE_DICTATION_TURN_MODEL", "mlx-community/smart-turn-v3")
LONG_PAUSE_FRAMES = RATE * 3 // 2 // FRAME
# The turn model reads at most this much of the phrase before the pause.
TURN_AUDIO = RATE * 8

replies = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
# Native code writes to fd 1 directly; point it at stderr so only replies reach the server.
os.dup2(2, 1)
sys.stdout = sys.stderr

MODEL = os.environ.get("OPENCODE_DICTATION_MODEL", "mlx-community/Qwen3-ASR-0.6B-8bit")
# Empty disables the fast model, so the main model writes everything.
FAST_MODEL = os.environ.get("OPENCODE_DICTATION_FAST_MODEL", "")
# The languages the fast model transcribes, by the main model's names; `None` is automatic detection.
FAST_LANGUAGES = {None, "English", "French", "German", "Spanish", "Portuguese", "Italian", "Japanese"}
HOTWORDS = [word for word in os.environ.get("OPENCODE_DICTATION_HOTWORDS", "").split("\n") if word.strip()]
# Latin letters or a katakana run in the fast model's text: where it may have spelled out an English term.
FOREIGN = re.compile(r"[A-Za-z]|[ァ-ヺー]{3,}")

models = {}
sessions = {}


def load(name=MODEL):
    if name not in models:
        from mlx_audio.stt import load as load_model

        models[name] = load_model(name)
        # The first decode compiles kernels; pay for it here rather than on the user's first word.
        models[name].generate(np.zeros(RATE // 2, dtype=np.float32))
    return models[name]


vad = None
turn = None


def finished(session, end):
    # Whether the phrase up to frame `end` sounds complete; asked once per pause.
    global turn
    if not TURN_MODEL:
        return True
    if end not in session.setdefault("turns", {}):
        if turn is None:
            from mlx_audio.vad import load as load_vad

            turn = load_vad(TURN_MODEL)
        audio = session["segment"][max(0, end * FRAME - TURN_AUDIO) : end * FRAME]
        session["turns"][end] = turn.predict_endpoint(audio, sample_rate=RATE).prediction == 1
    return session["turns"][end]


def listen(session, audio):
    # Speech probabilities for whole frames; the VAD carries its state across a session's chunks.
    global vad
    if not len(audio) or np.sqrt(np.mean(audio * audio)) < SILENT_RMS:
        return np.zeros(len(audio) // FRAME, dtype=np.float32)
    if vad is None:
        from mlx_audio.vad import load as load_vad

        vad = load_vad(VAD_MODEL)
    import mlx.core as mx

    scores = []
    for start in range(0, len(audio), FRAME):
        score, session["vad"] = vad.feed(audio[start : start + FRAME], session.get("vad"))
        scores.append(score.reshape(-1))
    return np.array(mx.concatenate(scores), dtype=np.float32)


# The model sometimes writes back the hotword list it was prompted with, alone or around the speech: several hotwords
# in a row joined by commas. Speech rarely lists three of them that way; two may well be meant.
HOTWORD_ECHO = (
    re.compile(
        r"(?:{0})(?:\s*[,、，]\s*(?:{0})){{{1},}}[,、，。.]?\s*".format(
            "|".join(re.escape(word) for word in sorted(HOTWORDS, key=len, reverse=True)), min(len(HOTWORDS), 3) - 1
        ),
        re.IGNORECASE,
    )
    if len(HOTWORDS) > 1
    else None
)


def strip_hotwords(text):
    return HOTWORD_ECHO.sub("", text).strip() if HOTWORD_ECHO else text


def decode(audio, speech, language, partial=False):
    if not (speech >= SPEECH).any():
        return ""
    if not FAST_MODEL or language not in FAST_LANGUAGES:
        return main(audio, language)
    text = load(FAST_MODEL).generate(audio).text.strip()
    if partial or not HOTWORDS or not FOREIGN.search(text):
        return text
    # Without a registered term the main model is no better at English words and worse at the rest.
    rewritten = main(audio, language)
    return rewritten if any(word.lower() in rewritten.lower() for word in HOTWORDS) else text


def main(audio, language):
    text = load().generate(audio, language=language, hotwords=HOTWORDS or None, temperature=0.0).text.strip()
    return strip_hotwords(text)


def join(parts):
    text = ""
    for part in (part for part in parts if part):
        # Japanese runs together; a space separates only Latin text on both sides.
        gap = " " if text and text[-1].isascii() and part[0].isascii() and not text[-1].isspace() else ""
        text += gap + part
    return text


def split_point(speech):
    # The least speech-like frame in the last few seconds, so a word is rarely cut in half.
    start = max(0, len(speech) - SEGMENT_SEARCH)
    return start + int(np.argmin(speech[start:]))


def pause_cut(session):
    # The frame in the middle of the last pause that follows speech, or None while the speaker has not paused.
    voiced = session["speech"] >= SPEECH
    if not voiced.any():
        return None
    cut, run = None, 0
    for index in range(int(np.argmax(voiced)), len(voiced)):
        run = 0 if voiced[index] else run + 1
        if run == PAUSE_FRAMES and finished(session, index + 1):
            cut = index - PAUSE_FRAMES // 2
        if run == LONG_PAUSE_FRAMES and TURN_MODEL:
            cut = index - LONG_PAUSE_FRAMES // 2
    return cut


def commit(session, frames, language):
    session["committed"].append(decode(session["segment"][: frames * FRAME], session["speech"][:frames], language))
    session["segment"] = session["segment"][frames * FRAME :]
    session["speech"] = session["speech"][frames:]
    session["turns"] = {}


def transcribe(request):
    # None lets the model detect the spoken language.
    language = request.get("language") or None
    final = request.get("final")
    empty = np.zeros(0, dtype=np.float32)
    session = sessions.setdefault(request["session"], {"committed": [], "segment": empty, "speech": empty, "rest": empty})
    pcm = np.frombuffer(base64.b64decode(request.get("audio") or ""), dtype="<i2").astype(np.float32) / 32768.0
    audio = np.concatenate([session["rest"], pcm])
    whole = len(audio) // FRAME * FRAME
    session["rest"] = audio[whole:]
    session["segment"] = np.concatenate([session["segment"], audio[:whole]])
    session["speech"] = np.concatenate([session["speech"], listen(session, audio[:whole])])
    cut = None if final else pause_cut(session)
    if cut:
        commit(session, cut, language)
        session["shown"] = ""
        # The VAD adapts to the loudness it has heard; a fresh state per phrase still hears a speaker who drops their
        # voice after a pause.
        session["vad"] = None
    elif not (session["speech"] >= SPEECH).any() and len(session["segment"]) > RATE:
        # Leading silence is never decoded; keep only its end so the next word starts a short segment.
        keep = PARTIAL_MIN // FRAME
        session["segment"], session["speech"] = session["segment"][-keep * FRAME :], session["speech"][-keep:]
    if not final and len(session["segment"]) > SEGMENT_MAX:
        commit(session, split_point(session["speech"]), language)
    pending = (
        decode(np.concatenate([session["segment"], session["rest"]]), session["speech"], language)
        if final
        else ""
        if len(session["segment"]) < PARTIAL_MIN
        else decode(session["segment"], session["speech"], language, partial=True)
    )
    # A partial pass that hears nothing new keeps the last words shown, so the prompt never blinks empty mid-phrase.
    if not final and not pending and session.get("shown"):
        pending = session["shown"]
    session["shown"] = pending
    text = join([*session["committed"], pending])
    if final:
        sessions.pop(request["session"], None)
        return {"text": text, "committed": text}
    return {"text": text, "committed": join(session["committed"])}


def handle(request):
    op = request.get("op")
    if op == "languages":
        from huggingface_hub import hf_hub_download

        with open(hf_hub_download(MODEL, "config.json"), encoding="utf-8") as config:
            return {"languages": json.load(config).get("support_languages", [])}
    if op == "load":
        listen({}, np.ones(FRAME, dtype=np.float32))
        finished({"segment": np.ones(RATE, dtype=np.float32)}, RATE // FRAME)
        if FAST_MODEL:
            load(FAST_MODEL)
        # Other languages and registered terms load the main model when first needed.
        if not FAST_MODEL or HOTWORDS:
            load()
        return {"model": FAST_MODEL or MODEL}
    if op == "transcribe":
        return transcribe(request)
    if op == "cancel":
        sessions.pop(request.get("session"), None)
        return {}
    raise ValueError(f"unknown op: {op}")


for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    try:
        reply = {"id": request.get("id"), **handle(request)}
    except Exception as error:  # noqa: BLE001 - every failure must reach the caller as a reply
        traceback.print_exc()
        reply = {"id": request.get("id"), "error": f"{type(error).__name__}: {error}"}
    replies.write(json.dumps(reply, ensure_ascii=False) + "\n")
