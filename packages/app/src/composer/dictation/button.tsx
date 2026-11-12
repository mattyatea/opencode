import { createMemo, createResource, createSignal, onCleanup, Show, untrack } from "solid-js"
import { Tooltip } from "@opencode/ui/tooltip"
import type { ComposerEditorModel } from "@/composer/editor/interaction"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useSettings } from "@/settings/model"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import { encodeChunks, level, RATE, toPcm16, withTranscript } from "./pcm"
import "./dictation.css"

/**
 * How often a new partial transcript is requested. A tick while a pass runs is skipped, so passes run back to back and
 * each one only waits for the previous decode (about 0.1–0.3 s).
 */
const PARTIAL_MS = 250

/** A model that has not answered `prepare` by then is loading or downloading; say so. */
const LOADING_TOAST_MS = 1500

type Phase = "idle" | "preparing" | "listening" | "finishing" | "cleaning"

/**
 * Dictation beside the send button: speech is transcribed on the server by a local MLX model and written into the
 * prompt while the user speaks. Shown only while the server offers dictation.
 */
export function ComposerDictation(props: { controller: ComposerEditorModel }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const settings = useSettings()
  const api = () => sdk.api.experimental.dictation

  const [status] = createResource(() =>
    api()
      .status()
      .catch(() => undefined),
  )

  const [phase, setPhase] = createSignal<Phase>("idle")
  const [meter, setMeter] = createSignal(0)

  const state: { stop?: (cleanup: boolean) => Promise<void>; abort?: () => void } = {}

  // A cleanup button beside stop replaces cleanup on stop.
  const cleanupButton = createMemo(() => settings.dictation.cleanup() && settings.dictation.trigger() === "button")

  const fail = (error: unknown) =>
    showToast({
      title: language.t("composer.dictation.error.title"),
      description: errorMessage(error, language.t("common.requestFailed")),
      variant: "error",
    })

  const cleanupModel = () => {
    const key = settings.dictation.model()
    const slash = key?.indexOf("/") ?? -1

    if (!key || slash < 1) return undefined

    return { providerID: key.slice(0, slash), id: key.slice(slash + 1), variant: settings.dictation.variant() }
  }

  const start = async () => {
    const controller = props.controller
    const draft = controller.draft()
    const id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
    const base = controller.value()
    // One language per recording, even if settings change while the user speaks.
    const recognition = settings.dictation.language()
    const spoken = recognition === "auto" ? undefined : recognition
    setPhase("preparing")

    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .catch(() => undefined)

    if (!stream) {
      reset()
      showToast({
        title: language.t("composer.dictation.error.title"),
        description: language.t("composer.dictation.error.microphone"),
        variant: "error",
      })

      return
    }

    // Capture starts before the model is ready, so words spoken while it loads are kept.
    const audio = new AudioContext({ sampleRate: RATE })
    const source = audio.createMediaStreamSource(stream)
    const processor = audio.createScriptProcessor(2048, 1, 1)
    const chunks: Int16Array[] = []
    processor.onaudioprocess = (event) => {
      const samples = event.inputBuffer.getChannelData(0)
      chunks.push(toPcm16(samples))
      setMeter(Math.min(1, level(samples) * 8))
    }

    source.connect(processor)
    processor.connect(audio.destination)

    const progress = { busy: false, ended: false }
    // Writes only into the draft dictation started in; another session's draft is left alone.
    const current = () => controller.draft() === draft

    const write = (text: string) => {
      if (current()) controller.setText(withTranscript(base, text))
    }

    const take = () => encodeChunks(chunks.splice(0))

    const release = () => {
      clearInterval(timer)
      clearTimeout(loading)
      processor.disconnect()
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      void audio.close()
      setMeter(0)
    }

    const loading = setTimeout(() => {
      if (progress.ended || phase() !== "preparing") return
      showToast({
        title: language.t("composer.dictation.loading.title"),
        description: language.t("composer.dictation.loading.description"),
        variant: "loading",
        duration: 8000,
      })
    }, LOADING_TOAST_MS)

    // Partial passes never overlap: a tick while one runs is skipped, and its audio goes into the next pass.
    const partial = async () => {
      if (progress.busy || progress.ended || phase() !== "listening") return
      progress.busy = true
      await api()
        .transcribe({ session: id, audio: take(), final: false, language: spoken })
        .then((result) => {
          if (!progress.ended) write(result.text)
        })
        .catch((error: unknown) => {
          if (progress.ended) return
          abort()
          fail(error)
        })
      progress.busy = false
    }

    const timer = setInterval(() => void partial(), PARTIAL_MS)

    const abort = () => {
      if (progress.ended) return
      progress.ended = true
      release()
      void api()
        .cancel({ session: id })
        .catch(() => undefined)
      reset()
    }

    const stop = async (cleanup: boolean) => {
      if (progress.ended) return
      progress.ended = true
      release()
      setPhase("finishing")

      // Let a running partial pass land first, so the final pass gets the remaining audio in order.
      while (progress.busy) await new Promise((resolve) => setTimeout(resolve, 20))

      const transcript = await api()
        .transcribe({ session: id, audio: take(), final: true, language: spoken })
        .then((result) => result.text)
        .catch((error: unknown) => {
          fail(error)

          return undefined
        })

      if (transcript === undefined) return reset()
      // The transcript as spoken lands first; cleanup replaces it only if nobody edited it meanwhile.
      write(transcript)
      const original = withTranscript(base, transcript)

      if (cleanup && transcript.trim()) {
        setPhase("cleaning")
        await api()
          .cleanup({ text: transcript, model: cleanupModel() })
          .then((result) => {
            if (controller.value() === original) write(result.text)
          })
          .catch((error: unknown) =>
            showToast({
              title: language.t("composer.dictation.error.cleanup"),
              description: errorMessage(error, language.t("common.requestFailed")),
              variant: "error",
            }),
          )
      }

      if (current()) controller.restoreFocus()
      reset()
    }

    state.stop = stop
    state.abort = abort

    await api()
      .prepare()
      .then(
        () => {
          clearTimeout(loading)

          if (!progress.ended) setPhase("listening")
        },
        (error: unknown) => {
          abort()
          fail(error)
        },
      )
  }

  const reset = () => {
    state.stop = undefined
    state.abort = undefined
    setPhase("idle")
  }

  const toggle = () => {
    const current = phase()

    if (current === "idle") return void start().catch(fail)

    if (current === "preparing") return state.abort?.()

    if (current === "listening")
      return void state.stop?.(untrack(() => settings.dictation.cleanup() && settings.dictation.trigger() === "stop"))
  }

  onCleanup(() => state.abort?.())

  const label = () =>
    language.t(
      (
        {
          idle: "composer.dictation.start",
          preparing: "composer.dictation.preparing",
          listening: "composer.dictation.stop",
          finishing: "composer.dictation.finishing",
          cleaning: "composer.dictation.cleaning",
        } as const
      )[phase()],
    )

  return (
    <Show when={status()?.available}>
      <div data-component="composer-dictation" class="composer-dictation">
        <Show when={phase() === "listening" && cleanupButton()}>
          <Tooltip placement="top" value={language.t("composer.dictation.cleanup")}>
            <button
              type="button"
              data-action="composer-dictation-cleanup"
              class="composer-dictation-button"
              aria-label={language.t("composer.dictation.cleanup")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void state.stop?.(true)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 4h11M2.5 8h7M2.5 12h4.5" />
                <path d="M12 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" class="composer-dictation-fill" />
              </svg>
            </button>
          </Tooltip>
        </Show>
        <Tooltip placement="top" value={label()}>
          <button
            type="button"
            data-action="composer-dictation"
            class="composer-dictation-button"
            data-phase={phase()}
            aria-label={label()}
            aria-pressed={phase() === "listening"}
            disabled={phase() === "finishing" || phase() === "cleaning"}
            style={{ "--composer-dictation-level": String(meter()) }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggle}
          >
            <span class="composer-dictation-ring" aria-hidden="true" />
            <Show
              when={phase() === "listening"}
              fallback={
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
                  <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15M5.5 15h5" />
                </svg>
              }
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" class="composer-dictation-fill" />
              </svg>
            </Show>
          </button>
        </Tooltip>
      </div>
    </Show>
  )
}
