# Voice input

Adds a microphone button beside the composer's send button in the desktop app. While you speak, the transcript
appears in the prompt and updates as the recognizer hears more. Press the button again (or `Mod+Shift+Space`) to stop;
a last pass over the whole recording replaces the live text. Nothing is sent until you send the prompt.

Speech is transcribed on your Mac with [MLX](https://github.com/ml-explore/mlx); audio never leaves the machine. It
needs a Mac with Apple Silicon.

## Install

```sh
opencode plugin add 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/voice-input'
```

The server part starts a Python worker on first use. By default it runs it through [uv](https://docs.astral.sh/uv/),
which builds and caches an environment with `mlx-audio` the first time. The model (about 1 GB) downloads to the Hugging
Face cache on the first dictation; later dictations start in a few seconds.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "git+https://github.com/anomalyco/opencode.git#path:packages/plugins/voice-input",
      "options": {
        // A Hugging Face repo of an mlx-audio speech-to-text model.
        "model": "mlx-community/Qwen3-ASR-0.6B-8bit",
        // Defaults to auto. The Voice input settings page overrides this per recording.
        "language": "auto",
        // Terms the recognizer should prefer, e.g. identifiers from your project.
        "hotwords": ["TypeScript", "setState"],
        // A Python with mlx-audio installed, instead of uv.
        "python": "/path/to/venv/bin/python",
        // The uv executable, when `uv` on PATH is not usable.
        "uv": "/opt/homebrew/bin/uv",
      },
    },
  ],
}
```

Hotwords pull similar-sounding speech toward themselves: with `OpenCode` as a hotword, a spoken "useEffect" came back as
"OpenCode". List only terms you actually dictate.

Settings → Voice input lets you select Auto (the initial value) or any language advertised by the model.
The default Qwen3-ASR model advertises 30 languages, including Japanese, English and Korean.
The list is read from its configuration, without downloading model weights.
Selections are saved and take effect on the next recording.

## Model choice

### Optional cleanup after dictation

Set `options.cleanup` to an explicit small language model to remove fillers and organize the final transcript:

```jsonc
"cleanup": {
  "model": { "providerID": "inception", "id": "mercury-3", "variant": "instant" }
}
```

Use any text model configured in OpenCode, including Haiku, by setting its provider and model ids.
Cleanup is disabled by default (`"cleanup": false`), and is never run on live partials.
After stopping, the raw transcript is shown first, then replaced with the edited text.
If generation fails or returns empty text, the original stays. Edits you type while waiting are not overwritten.
Only the dictated text is sent, not the rest of the prompt or session history. Unlike local MLX transcription,
this sends text to the chosen provider and uses its quota or incurs its normal generation charges.
The model is instructed to preserve meaning, uncertainty, negations, numbers and technical identifiers, but
this is not a guarantee: review the result before sending.

Measured on an Apple M3 Pro (36 GB) with mlx-audio 0.6.5 and mlx-whisper 0.4.3, on five synthesized Japanese sentences
that mix in English technical terms (macOS `say -v Kyoko`, 16 kHz), with eight hotwords:

| Model                                | Mean CER | RTF   | Decode of 1 s / 3 s / 6 s of audio |
| ------------------------------------ | -------- | ----- | ---------------------------------- |
| `mlx-community/Qwen3-ASR-0.6B-8bit`  | 8.6 %    | 0.052 | 0.17 / 0.15 / 0.30 s               |
| `mlx-community/Qwen3-ASR-1.7B-8bit`  | 15.0 %   | 0.104 | 0.30 / 0.40 / 0.68 s               |
| `mlx-community/whisper-large-v3-turbo` | 8.7 %  | 0.152 | 0.74 / 0.76 / 0.85 s               |

Qwen3-ASR 0.6B is as accurate as Whisper large-v3-turbo here and decodes 3–5× faster, which is what lets the worker
re-transcribe the current phrase several times a second. It also takes hotwords. The synthetic set is small, and published
FLEURS-ja results rank 1.7B and Whisper turbo ahead of 0.6B, so for longer, natural speech set `model` to
`mlx-community/Qwen3-ASR-1.7B-8bit` if the extra latency is acceptable. Natively streaming MLX models (Voxtral Realtime,
Nemotron 3.5 ASR) report clearly worse Japanese accuracy at sub-second delays, and Parakeet-ja and kotoba-whisper are
Japanese-only.

## How it works

- The window part captures the microphone at 16 kHz and sends the new audio every 0.25 s (a pass never overlaps the previous one) to the server part's `transcribe`
  RPC. Captured audio is kept while the model loads, so nothing said meanwhile is lost.
- The worker keeps each dictation's audio. It re-transcribes only the current phrase: a 0.5 s pause after speech commits it, and a
  phrase longer than 20 s is committed at its quietest point, so a long dictation never re-decodes minutes of audio. Silent segments and partial passes on
  less than 0.5 s of audio are not decoded, which avoids invented text.
- The prompt shows the text it held when dictation started, then the transcript. Mentions typed before dictation become
  plain text while dictating.

## Develop

```sh
bun run build      # writes dist/gui-experimental.cjs; commit it, git installs run no build
bun typecheck
OPENCODE_VOICE_PYTHON=/path/to/venv/bin/python bun test
```
