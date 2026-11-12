"""Local MLX speech-to-text worker for OpenCode dictation.

Reads one JSON request per line on stdin and writes one JSON reply per line on stdout:

  {"id": 1, "op": "load"}                                        -> {"id": 1, "model": "..."}
  {"id": 2, "op": "transcribe", "session": "s", "audio": "<b64>", "final": false} -> {"id": 2, "text": "...", "committed": "..."}
  {"id": 3, "op": "cancel", "session": "s"}                       -> {"id": 3}
  {"id": 4, "op": "languages"}                                   -> {"id": 4, "languages": ["Japanese", ...]}

`audio` is little-endian 16-bit mono PCM at 16 kHz, appended to the session's buffer. Each transcribe returns the
transcript of everything the session has heard so far, and `committed`, the start of it that later audio no longer
changes; `final` ends the session. Failures reply {"id", "error"}.
The unsettled end of a partial transcript comes from the faster draft model when one is set and knows the language;
committed segments and the final pass always use the main model, which follows the hotwords.
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
FRAME = RATE * 30 // 1000
# A segment longer than this is committed at its quietest point, so a long dictation never re-decodes minutes of audio.
SEGMENT_MAX = RATE * 20
SEGMENT_SEARCH = RATE * 6
# Frames quieter than this (about -44 dBFS) count as silence. A segment without a louder frame is never decoded,
# which stops the model from inventing text on silence.
VOICE_RMS = 0.006
# Partial passes wait for this much audio; a fraction of a word decodes into guesses that flicker in the prompt.
PARTIAL_MIN = RATE // 2
# A pause this long after speech commits the segment, so each partial pass re-decodes only the current phrase.
PAUSE_FRAMES = 500 // 30

replies = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
# Native code writes to fd 1 directly; point it at stderr so only replies reach the server.
os.dup2(2, 1)
sys.stdout = sys.stderr

MODEL = os.environ.get("OPENCODE_DICTATION_MODEL", "mlx-community/Qwen3-ASR-0.6B-8bit")
# Empty disables the draft model, so partial passes use the main model too.
DRAFT_MODEL = os.environ.get("OPENCODE_DICTATION_DRAFT_MODEL", "")
# The languages the draft model transcribes, by the main model's names; `None` is automatic detection.
DRAFT_LANGUAGES = {None, "English", "French", "German", "Spanish", "Portuguese", "Italian", "Japanese"}
HOTWORDS = [word for word in os.environ.get("OPENCODE_DICTATION_HOTWORDS", "").split("\n") if word.strip()]

models = {}
sessions = {}


def load(name=MODEL):
    if name not in models:
        from mlx_audio.stt import load as load_model

        models[name] = load_model(name)
        # The first decode compiles kernels; pay for it here rather than on the user's first word.
        models[name].generate(np.zeros(RATE // 2, dtype=np.float32))
    return models[name]


def frames_rms(audio):
    count = len(audio) // FRAME
    if count == 0:
        return np.zeros(0, dtype=np.float32)
    framed = audio[: count * FRAME].reshape(count, FRAME)
    return np.sqrt(np.mean(framed * framed, axis=1))


def echoes_hotwords(text):
    # On very little speech the model can answer with the hotword list it was prompted with.
    words = [word for word in re.split(r"[\s,、，。.]+", text) if word]
    hotwords = {word.lower() for word in HOTWORDS}
    return bool(words) and all(word.lower() in hotwords for word in words) and len(words) > 1


def decode(audio, language, draft=False):
    rms = frames_rms(audio)
    if len(rms) == 0 or rms.max() < VOICE_RMS:
        return ""
    if draft and DRAFT_MODEL and language in DRAFT_LANGUAGES:
        return load(DRAFT_MODEL).generate(audio).text.strip()
    text = load().generate(audio, language=language, hotwords=HOTWORDS or None, temperature=0.0).text.strip()
    return "" if echoes_hotwords(text) else text


def join(parts):
    text = ""
    for part in (part for part in parts if part):
        # Japanese runs together; a space separates only Latin text on both sides.
        gap = " " if text and text[-1].isascii() and part[0].isascii() and not text[-1].isspace() else ""
        text += gap + part
    return text


def split_point(audio):
    # The quietest frame in the last few seconds, so a word is rarely cut in half.
    start = max(0, len(audio) - SEGMENT_SEARCH)
    rms = frames_rms(audio[start:])
    return start + int(np.argmin(rms)) * FRAME if len(rms) else len(audio)


def pause_cut(audio):
    # The middle of the last pause that follows speech, or None while the speaker has not paused.
    voiced = frames_rms(audio) >= VOICE_RMS
    if not voiced.any():
        return None
    cut, run = None, 0
    for index in range(int(np.argmax(voiced)), len(voiced)):
        run = 0 if voiced[index] else run + 1
        if run == PAUSE_FRAMES:
            cut = (index - PAUSE_FRAMES // 2) * FRAME
    return cut


def transcribe(request):
    # None lets the model detect the spoken language.
    language = request.get("language") or None
    session = sessions.setdefault(request["session"], {"committed": [], "segment": np.zeros(0, dtype=np.float32)})
    pcm = np.frombuffer(base64.b64decode(request.get("audio") or ""), dtype="<i2").astype(np.float32) / 32768.0
    session["segment"] = np.concatenate([session["segment"], pcm])
    cut = None if request.get("final") else pause_cut(session["segment"])
    if cut:
        session["committed"].append(decode(session["segment"][:cut], language))
        session["segment"] = session["segment"][cut:]
        session["shown"] = ""
    elif frames_rms(session["segment"]).max(initial=0) < VOICE_RMS and len(session["segment"]) > RATE:
        # Leading silence is never decoded; keep only its end so the next word starts a short segment.
        session["segment"] = session["segment"][-RATE // 2 :]
    if not request.get("final") and len(session["segment"]) > SEGMENT_MAX:
        cut = split_point(session["segment"])
        session["committed"].append(decode(session["segment"][:cut], language))
        session["segment"] = session["segment"][cut:]
    final = request.get("final")
    pending = (
        decode(session["segment"], language)
        if final
        else "" if len(session["segment"]) < PARTIAL_MIN else decode(session["segment"], language, draft=True)
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
        load()
        if DRAFT_MODEL:
            load(DRAFT_MODEL)
        return {"model": MODEL}
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
