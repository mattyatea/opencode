import { type Component, createMemo, createResource, Show } from "solid-js"
import type { ConfigEntry } from "@opencode/client/promise"
import { Select } from "@opencode/ui/select"
import { useModels } from "@/providers/models/models"
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

  // `voice.work_model`, as provider/model or provider/model#variant; empty keeps the main session's model.
  const workModel = createOptimisticSetting<string, undefined, ServerCtx>({
    source: () => server.ctx,
    initial: "",
    initialMeta: undefined,
    load: async (ctx) => ({
      meta: undefined,
      value:
        globalVoice(await ctx.sdk.api.config.get())
          .flatMap((item) => (item.work_model ? [item.work_model] : []))
          .at(-1) ?? "",
    }),
    write: async (value, ctx) => {
      await ctx.sdk.api.experimental.config.update({ voice: { work_model: value || null } })
    },
    onError: failed,
  })

  const catalog = useModels()

  const workOptions = createMemo(() => [
    undefined,
    ...catalog
      .list()
      .filter((item) => catalog.visible({ providerID: item.provider.id, modelID: item.id }))
      .map((item) => ({ key: `${item.provider.id}/${item.id}`, item })),
  ])

  const workSelected = createMemo(() => {
    const key = workModel.value().split("#")[0]

    return workOptions().find((option) => option?.key === key)
  })

  const workVariants = createMemo(() => [undefined, ...Object.keys(workSelected()?.item.variants ?? {})])

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
          <h3 class="settings-section-title">{language.t("settings.voice.section.work")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.voice.workModel.title")}
              description={language.t("settings.voice.workModel.description")}
            >
              <Select
                data-action="settings-voice-work-model"
                options={workOptions()}
                current={workSelected()}
                value={(option) => option?.key ?? ""}
                label={(option) => option?.item.name ?? language.t("settings.voice.workModel.default")}
                groupBy={(option) => option?.item.provider.name ?? ""}
                onSelect={(option) => workModel.select(option?.key ?? "")}
                placement="bottom-end"
                gutter={6}
              />
            </SettingsRow>
            <Show when={workVariants().length > 1}>
              <SettingsRow
                title={language.t("settings.voice.workVariant.title")}
                description={language.t("settings.voice.workVariant.description")}
              >
                <Select
                  data-action="settings-voice-work-variant"
                  options={workVariants()}
                  current={workModel.value().split("#")[1]}
                  value={(variant) => variant ?? ""}
                  label={(variant) => variant ?? language.t("settings.voice.workVariant.default")}
                  onSelect={(variant) => {
                    const key = workSelected()?.key

                    if (key) workModel.select(variant ? `${key}#${variant}` : key)
                  }}
                  placement="bottom-end"
                  gutter={6}
                />
              </SettingsRow>
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
