import { type Component, createResource, Show } from "solid-js"
import type { ConfigEntry } from "@opencode/client/promise"
import { Select } from "@opencode/ui/select"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import type { ServerCtx } from "@/runtime/server/runtime"
import { createOptimisticSetting } from "@/settings/general/controllers"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { showToast } from "@/shell/notifications/toast"
import "@/settings/settings.css"

type Provider = "auto" | "openai" | "chatgpt"

const providers: Provider[] = ["auto", "openai", "chatgpt"]

// The voices GPT-Live speaks with on the ChatGPT plan; the server's choice when none is set.
const voices = [
  "default",
  "cove",
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
]

/** The server's global config documents, before its project directories. */
const globalVoice = (entries: readonly ConfigEntry[]) => {
  const boundary = entries.findIndex((entry) => entry.type === "directory")

  return (boundary === -1 ? entries : entries.slice(0, boundary)).flatMap((entry) =>
    entry.type === "document" && entry.info.voice ? [entry.info.voice] : [],
  )
}

/** Desktop voice calls on the selected server: which provider runs them and how the ChatGPT plan sounds. */
export const SettingsVoice: Component = () => {
  const language = useLanguage()
  const server = useServer()

  const failed = () => showToast({ variant: "error", title: language.t("common.requestFailed") })

  const provider = createOptimisticSetting<Provider, undefined, ServerCtx>({
    source: () => server.ctx,
    initial: "auto",
    initialMeta: undefined,
    load: async (ctx) => ({
      meta: undefined,
      value:
        globalVoice(await ctx.sdk.api.config.get())
          .flatMap((voice) => (voice.provider ? [voice.provider] : []))
          .at(-1) ?? "auto",
    }),
    write: async (value, ctx) => {
      await ctx.sdk.api.experimental.config.update({ voice: { provider: value === "auto" ? null : value } })
      void refetch()
    },
    onError: failed,
  })

  const voice = createOptimisticSetting<string, undefined, ServerCtx>({
    source: () => server.ctx,
    initial: "default",
    initialMeta: undefined,
    load: async (ctx) => ({
      meta: undefined,
      value:
        globalVoice(await ctx.sdk.api.config.get())
          .flatMap((item) => (item.chatgpt?.voice ? [item.chatgpt.voice] : []))
          .at(-1) ?? "default",
    }),
    write: async (value, ctx) => {
      await ctx.sdk.api.experimental.config.update({ voice: { chatgpt_voice: value === "default" ? null : value } })
    },
    onError: failed,
  })

  const [models, { refetch }] = createResource(() =>
    server.ctx.sdk.api.experimental.voice.models().catch(() => undefined),
  )

  // Read only once loaded: a settings read must not suspend the whole route.
  const offered = () => (models.state === "ready" || models.state === "refreshing" ? models.latest : undefined)

  const status = () => {
    const current = offered()

    if (!current) return undefined

    if (current.default === "chatgpt-live") return language.t("settings.voice.status.chatgpt")

    if (current.default) return language.t("settings.voice.status.live")

    return language.t("settings.voice.status.none")
  }

  const signedOut = () => offered()?.models.some((model) => model.model === "chatgpt-live" && !model.available) ?? false

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.voice")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.voice.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.voice.section.provider")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.voice.provider.title")}
              description={language.t("settings.voice.provider.description")}
            >
              <Select
                data-action="settings-voice-provider"
                options={providers}
                current={provider.value()}
                label={(value) => language.t(`settings.voice.provider.${value}`)}
                onSelect={(value) => value && provider.select(value)}
                placement="bottom-end"
                gutter={6}
              />
            </SettingsRow>
            <Show when={status()}>
              {(text) => (
                <SettingsRow
                  title={language.t("settings.voice.status.title")}
                  description={language.t("settings.voice.status.description")}
                >
                  <span class="text-12-regular text-v2-text-text-muted">{text()}</span>
                </SettingsRow>
              )}
            </Show>
          </SettingsList>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.voice.section.chatgpt")}</h3>
          <Show when={signedOut()}>
            <p class="text-12-regular text-v2-text-text-muted">{language.t("settings.voice.signin.missing")}</p>
          </Show>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.voice.voice.title")}
              description={language.t("settings.voice.voice.description")}
            >
              <Select
                data-action="settings-voice-voice"
                options={voices}
                current={voice.value()}
                label={(value) => (value === "default" ? language.t("settings.voice.voice.default") : value)}
                onSelect={(value) => value && voice.select(value)}
                placement="bottom-end"
                gutter={6}
              />
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
