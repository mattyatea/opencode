import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Schema } from "effect"
import { Command, Plugin, SettingsPage, Slot, Store, Style, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import { Dictation } from "../rpc"
import en from "../i18n/en"
import ja from "../i18n/ja"
import { encodeChunks, level, RATE, toPcm16, withTranscript } from "./pcm"
import css from "./style.css?inline"

/**
 * How often the window asks for a new partial transcript. A tick while a pass runs is skipped, so passes run back to
 * back and each one only waits for the previous decode (about 0.1–0.3 s).
 */
const PARTIAL_MS = 250
/** A model that has not answered `prepare` by then is loading or downloading; say so. */
const LOADING_TOAST_MS = 1500

type Phase = "idle" | "preparing" | "listening" | "finishing"

export default Plugin.define({
  i18n: { en, ja },
  stores: {
    preferences: Store.global(Schema.Struct({ language: Schema.String }), { language: "auto" }),
  },
  setup(ctx) {
    const [phase, setPhase] = createSignal<Phase>("idle")
    const [meter, setMeter] = createSignal(0)
    // The session key of the running dictation; one dictation at a time across the window.
    const [owner, setOwner] = createSignal<string>()
    const state: { stop?: () => Promise<void>; abort?: () => void } = {}

    const fail = (error: unknown) => {
      const message =
        typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error)
      ctx.toast.show({ title: ctx.t("error.title"), description: message, variant: "error" })
    }

    const start = async (screen: SessionScreen, session: MountedSession) => {
      const location = session.location ? { directory: session.location.directory } : undefined
      const rpc = ctx.client.rpc(Dictation)
      const id = `${session.key}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
      const base = screen.composer.text()
      // One language per recording, even if settings change while the user speaks.
      const language = ctx.stores.preferences.value.language
      setOwner(session.key)
      setPhase("preparing")

      const stream = await navigator.mediaDevices
        .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
        .catch(() => undefined)
      if (!stream) {
        reset()
        ctx.toast.show({ title: ctx.t("error.title"), description: ctx.t("error.microphone"), variant: "error" })
        return
      }

      // Capture starts before the model is ready, so words spoken while it loads are kept.
      const audio = new AudioContext({ sampleRate: RATE })
      const source = audio.createMediaStreamSource(stream)
      // ScriptProcessor needs no worklet module, which a plugin bundle cannot ship as a second file.
      const processor = audio.createScriptProcessor(2048, 1, 1)
      const chunks: Int16Array[] = []
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0)
        chunks.push(toPcm16(samples))
        setMeter(Math.min(1, level(samples) * 8))
      }
      source.connect(processor)
      processor.connect(audio.destination)

      const release = () => {
        clearInterval(timer)
        processor.disconnect()
        source.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void audio.close()
        setMeter(0)
      }
      const take = () => encodeChunks(chunks.splice(0))
      const write = (text: string) => {
        if (owner() === session.key) screen.composer.setText(withTranscript(base, text))
      }

      const loading = setTimeout(
        () =>
          !ended &&
          phase() === "preparing" &&
          ctx.toast.show({
            title: ctx.t("loading.title"),
            description: ctx.t("loading.description"),
            variant: "loading",
            duration: 8000,
          }),
        LOADING_TOAST_MS,
      )
      let busy = false
      let ended = false
      // Partial passes never overlap: a tick while one runs is skipped, and its audio goes into the next pass.
      const partial = async () => {
        if (busy || ended || phase() !== "listening") return
        busy = true
        await rpc
          .transcribe({ session: id, audio: take(), final: false, language }, { location })
          .then((result) => !ended && write(result.text))
          .catch((error: unknown) => {
            if (ended) return
            abort()
            fail(error)
          })
        busy = false
      }
      const timer = setInterval(() => void partial(), PARTIAL_MS)

      const abort = () => {
        if (ended) return
        ended = true
        clearTimeout(loading)
        release()
        void rpc.cancel({ session: id }, { location }).catch(() => undefined)
        reset()
      }
      const stop = async () => {
        if (ended) return
        ended = true
        clearTimeout(loading)
        release()
        setPhase("finishing")
        // Let a running partial pass land first, so the final pass gets the remaining audio in order.
        while (busy) await new Promise((resolve) => setTimeout(resolve, 20))
        await rpc
          .transcribe({ session: id, audio: take(), final: true, language }, { location })
          .then(async (result) => {
            write(result.text)
            const original = withTranscript(base, result.text)
            const cleaned = await rpc.cleanup({ text: result.text }, { location })
            // Do not overwrite a user's edits or a different session while the model was working.
            if (ctx.sessions.current()?.key === session.key && screen.composer.text() === original)
              write(cleaned.text)
            screen.composer.focus()
          })
          .catch(fail)
        reset()
      }
      state.stop = stop
      state.abort = abort

      await rpc.prepare({}, { location }).then(
        () => {
          clearTimeout(loading)
          if (!ended) setPhase("listening")
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
      setOwner(undefined)
      setPhase("idle")
    }

    const toggle = (screen: SessionScreen, session: MountedSession) => {
      if (phase() === "idle") return void start(screen, session).catch(fail)
      if (owner() !== session.key) return
      if (phase() === "preparing") return state.abort?.()
      if (phase() === "listening") return void state.stop?.()
    }

    onCleanup(() => state.abort?.())

    ctx.add(Style, css)

    ctx.add(SettingsPage, {
      id: "voice",
      get title() { return ctx.t("settings.title") },
      icon: "waveform",
      render: () => {
        const [languages, setLanguages] = createSignal<readonly string[]>([])
        const [loading, setLoading] = createSignal(false)
        const [error, setError] = createSignal("")
        const lifetime = new AbortController()
        onCleanup(() => lifetime.abort())
        const refresh = async () => {
          setLoading(true)
          setError("")
          await ctx.client.rpc(Dictation).languages({}, { signal: lifetime.signal }).then(
            (result) => { if (!lifetime.signal.aborted) setLanguages(result.languages) },
            () => { if (!lifetime.signal.aborted) setError(ctx.t("settings.error")) },
          )
          if (!lifetime.signal.aborted) setLoading(false)
        }
        onMount(() => void refresh())
        return (
          <ctx.ui.SettingsLayout title={ctx.t("settings.title")}>
            <ctx.ui.SettingsSection footer={error()}>
              <ctx.ui.SettingsRow title={ctx.t("settings.language")} description={ctx.t("settings.description")}>
                <ctx.ui.Select
                  label={ctx.t("settings.language")}
                  options={[
                    { value: "auto", label: ctx.t("settings.auto") },
                    ...languages().map((language) => ({
                      value: language,
                      label: Object.hasOwn(en, `language.${language}`) ? ctx.t(`language.${language}`) : language,
                    })),
                  ]}
                  value={ctx.stores.preferences.value.language}
                  onChange={(language) => void ctx.stores.preferences.update((draft) => { draft.language = language })}
                />
              </ctx.ui.SettingsRow>
              <ctx.ui.SettingsRow title={ctx.t("settings.languages")} description={ctx.t("settings.download")}>
                <ctx.ui.Button onClick={() => void refresh()} disabled={loading()}>
                  {loading() ? ctx.t("settings.loading") : ctx.t("settings.reload")}
                </ctx.ui.Button>
              </ctx.ui.SettingsRow>
            </ctx.ui.SettingsSection>
          </ctx.ui.SettingsLayout>
        )
      },
    })

    ctx.add(
      Command,
      (): Command => ({
        id: "toggle",
        title: ctx.t("command.toggle"),
        bind: "mod+shift+space",
        section: "prompt",
        run: () => {
          const screen = ctx.screen.current()
          const session = ctx.sessions.current()
          if (!screen || !session) return false
          toggle(screen, session)
        },
      }),
    )

    ctx.add(Slot, {
      at: "session.composer.actions",
      render: (input) => {
        const mine = () => owner() === input.session.key
        const current = () => (mine() ? phase() : "idle")
        const label = () =>
          ({
            idle: ctx.t("start"),
            preparing: ctx.t("preparing"),
            listening: ctx.t("stop"),
            finishing: ctx.t("finishing"),
          })[current()]
        return (
          <ctx.ui.Tooltip value={label()} keys={ctx.keybinds.keybind(`${ctx.id}.toggle`)}>
            <button
              type="button"
              data-action="voice-input"
              class="oc-voice-input"
              data-phase={current()}
              aria-label={label()}
              aria-pressed={current() === "listening"}
              disabled={current() === "finishing" || (!!owner() && !mine())}
              style={{ "--oc-voice-level": String(mine() ? meter() : 0) }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => toggle(input.screen, input.session)}
            >
              <span class="oc-voice-input-ring" aria-hidden="true" />
              <Show
                when={current() === "listening"}
                fallback={
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
                    <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15M5.5 15h5" />
                  </svg>
                }
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" class="oc-voice-input-stop" />
                </svg>
              </Show>
            </button>
          </ctx.ui.Tooltip>
        )
      },
    })
  },
})
