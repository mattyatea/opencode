import { type Component, createMemo, createResource, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { useModels } from "@/providers/models/models"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { SettingsList } from "@/settings/list"
import { type DictationCleanupTrigger, useSettings } from "@/settings/model"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

// The speech model names its languages in English; these tags let the interface name them in its own language.
const languageTags = new Map(
  Object.entries({
    Arabic: "ar",
    Cantonese: "yue",
    Chinese: "zh",
    Czech: "cs",
    Danish: "da",
    Dutch: "nl",
    English: "en",
    Filipino: "fil",
    Finnish: "fi",
    French: "fr",
    German: "de",
    Greek: "el",
    Hindi: "hi",
    Hungarian: "hu",
    Indonesian: "id",
    Italian: "it",
    Japanese: "ja",
    Korean: "ko",
    Macedonian: "mk",
    Malay: "ms",
    Persian: "fa",
    Polish: "pl",
    Portuguese: "pt",
    Romanian: "ro",
    Russian: "ru",
    Spanish: "es",
    Swedish: "sv",
    Thai: "th",
    Turkish: "tr",
    Vietnamese: "vi",
  }),
)

const triggers: DictationCleanupTrigger[] = ["stop", "button"]

/** Dictation preferences, kept on this device; the selected server lists the languages and cleanup models. */
export const SettingsDictation: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const sdk = useServerSDK()
  const models = useModels()
  const api = () => sdk.api.experimental.dictation

  const [status] = createResource(() =>
    api()
      .status()
      .catch(() => undefined),
  )

  const [languages, { refetch }] = createResource(() =>
    api()
      .languages()
      .then((result) => result.languages),
  )

  const names = createMemo(() => {
    const display = new Intl.DisplayNames([language.intl()], { type: "language" })

    return (name: string) => {
      const tag = languageTags.get(name)

      return tag ? (display.of(tag) ?? name) : name
    }
  })

  // A settings read must not suspend the whole route, so resources are read only once they have a value.
  const languageOptions = createMemo(() => [
    "auto",
    ...(languages.state === "ready" || languages.state === "refreshing" ? languages.latest : []),
  ])

  const modelOptions = createMemo(() => [
    undefined,
    ...models
      .list()
      .filter((item) => models.visible({ providerID: item.provider.id, modelID: item.id }))
      .map((item) => ({ key: `${item.provider.id}/${item.id}`, item })),
  ])

  const selectedModel = createMemo(() => modelOptions().find((option) => option?.key === settings.dictation.model()))
  const variantOptions = createMemo(() => [undefined, ...Object.keys(selectedModel()?.item.variants ?? {})])

  const unavailable = () => {
    const reason = status.state === "ready" ? status()?.reason : undefined

    if (reason === "disabled") return language.t("settings.dictation.unavailable.disabled")

    if (reason === "unsupported") return language.t("settings.dictation.unavailable.unsupported")
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.dictation")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.dictation.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <Show when={unavailable()}>
          {(message) => <p class="text-12-regular text-v2-text-text-muted">{message()}</p>}
        </Show>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.dictation.section.recognition")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.dictation.language.title")}
              description={
                languages.error
                  ? language.t("settings.dictation.language.error")
                  : language.t("settings.dictation.language.description")
              }
            >
              <div class="flex items-center gap-2">
                <Show when={languages.error}>
                  <Button variant="outline" size="small" disabled={languages.loading} onClick={() => void refetch()}>
                    {languages.loading
                      ? language.t("settings.dictation.language.loading")
                      : language.t("settings.dictation.language.reload")}
                  </Button>
                </Show>
                <Select
                  data-action="settings-dictation-language"
                  options={languageOptions()}
                  current={settings.dictation.language()}
                  label={(value) =>
                    value === "auto" ? language.t("settings.dictation.language.auto") : names()(value)
                  }
                  onSelect={(value) => value && settings.dictation.setLanguage(value)}
                  placement="bottom-end"
                  gutter={6}
                />
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.dictation.section.cleanup")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.dictation.cleanup.title")}
              description={language.t("settings.dictation.cleanup.description")}
            >
              <div data-action="settings-dictation-cleanup">
                <Switch
                  checked={settings.dictation.cleanup()}
                  onChange={(checked) => settings.dictation.setCleanup(checked)}
                />
              </div>
            </SettingsRow>
            <Show when={settings.dictation.cleanup()}>
              <SettingsRow
                title={language.t("settings.dictation.model.title")}
                description={language.t("settings.dictation.model.description")}
              >
                <Select
                  data-action="settings-dictation-model"
                  options={modelOptions()}
                  current={selectedModel()}
                  value={(option) => option?.key ?? ""}
                  label={(option) => option?.item.name ?? language.t("settings.dictation.model.default")}
                  groupBy={(option) => option?.item.provider.name ?? ""}
                  onSelect={(option) => settings.dictation.setModel(option?.key)}
                  placement="bottom-end"
                  gutter={6}
                />
              </SettingsRow>
              <Show when={variantOptions().length > 1}>
                <SettingsRow
                  title={language.t("settings.dictation.variant.title")}
                  description={language.t("settings.dictation.variant.description")}
                >
                  <Select
                    data-action="settings-dictation-variant"
                    options={variantOptions()}
                    current={settings.dictation.variant()}
                    value={(variant) => variant ?? ""}
                    label={(variant) => variant ?? language.t("settings.dictation.variant.default")}
                    onSelect={(variant) =>
                      settings.dictation.setModel(settings.dictation.model(), variant ?? undefined)
                    }
                    placement="bottom-end"
                    gutter={6}
                  />
                </SettingsRow>
              </Show>
              <SettingsRow
                title={language.t("settings.dictation.trigger.title")}
                description={language.t("settings.dictation.trigger.description")}
              >
                <Select
                  data-action="settings-dictation-trigger"
                  options={triggers}
                  current={settings.dictation.trigger()}
                  label={(trigger) => language.t(`settings.dictation.trigger.${trigger}`)}
                  onSelect={(trigger) => trigger && settings.dictation.setTrigger(trigger)}
                  placement="bottom-end"
                  gutter={6}
                />
              </SettingsRow>
            </Show>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
