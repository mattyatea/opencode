import type { ModelInfo, ModelRef } from "@opencode/client"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogIntegration } from "./dialog-integration"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"
import { modelPreferenceKey } from "../model-preference"
import { useLocation } from "../context/location"
import { useNewDesigns } from "../config"
import { DialogFreeModels } from "./dialog-model-free"
import { FavoriteMarker, isFreeModel, prioritizeFavorites, sortModelOptions } from "./model-options"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const dialog = useDialog()
  const newDesigns = useNewDesigns()
  const connected = useConnected()
  const data = useData()
  const route = useRoute()

  function commit(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  function select(providerID: string, modelID: string) {
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    const previous = sessionID ? data.session.get(sessionID)?.model : undefined
    if (
      sessionID &&
      previous &&
      previous.providerID !== providerID &&
      data.session.message
        .list(sessionID)
        .some(
          (message) =>
            message.type === "user" ||
            message.type === "assistant" ||
            (message.type === "compaction" && message.status === "completed"),
        )
    ) {
      dialog.replace(() => (
        <DialogModelSwitch
          sessionID={sessionID}
          model={{ providerID, id: modelID }}
          onSwitch={() => commit(providerID, modelID)}
        />
      ))
      return
    }
    commit(providerID, modelID)
  }

  function connect() {
    dialog.replace(() => (
      <DialogIntegration onConnected={(providerID) => dialog.replace(() => <DialogModel providerID={providerID} />)} />
    ))
  }

  return (
    <Show
      when={newDesigns() && !connected() && !props.providerID}
      fallback={<DialogConnectedModels providerID={props.providerID} onSelect={select} onConnect={connect} />}
    >
      <DialogFreeModels onSelect={select} onConnect={connect} />
    </Show>
  )
}

function DialogModelSwitch(props: { sessionID: string; model: ModelRef; onSwitch: () => void }) {
  const data = useData()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  let disposed = false
  onCleanup(() => (disposed = true))

  return (
    <DialogSelect
      title={busy() ? "Compacting before switching…" : "Switch provider"}
      description="Prompt caches are not shared between providers. Compaction can lose detail."
      renderFilter={false}
      locked={busy()}
      options={[
        { title: "Switch without compaction", value: false },
        { title: "Compact and switch", value: true, description: "Summarize with the current model first" },
      ]}
      onSelect={(option) => {
        if (busy()) return
        if (!option.value) return props.onSwitch()
        setBusy(true)
        void data.session.compactForModelSwitch({ sessionID: props.sessionID, model: props.model }).then(
          () => {
            if (!disposed) props.onSwitch()
          },
          (error) => {
            if (disposed) return
            setBusy(false)
            toast.show({ title: "Compaction failed", message: errorMessage(error), variant: "error" })
          },
        )
      }}
    />
  )
}

function DialogConnectedModels(props: {
  providerID?: string
  onSelect: (providerID: string, modelID: string) => void
  onConnect: () => void
}) {
  const local = useLocal()
  const newDesigns = useNewDesigns()
  const data = useData()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  // Under new designs, favoriting does not reorder the list until the dialog is reopened.
  const favoritesAtOpen = [...local.model.favorite()]
  const favoritePriority = new Set(favoritesAtOpen.map(modelPreferenceKey))
  const isFavorite = (value: { providerID: string; modelID: string } | undefined) =>
    value !== undefined &&
    local.model.favorite().some((item) => item.providerID === value.providerID && item.modelID === value.modelID)
  // Under new designs the detail row shows the price, so the trailing slot only marks favorites.
  const trailing = (model: ModelInfo, favorite: boolean) => {
    if (newDesigns()) return favorite ? <FavoriteMarker /> : undefined
    return isFreeModel(model) ? "Free" : undefined
  }
  // OpenCode's own free models get their own group at the end of the list instead of joining "OpenCode".
  const freeGroup = (model: ModelInfo) =>
    newDesigns() && !props.providerID && model.providerID === "opencode" && isFreeModel(model)

  const connected = useConnected()
  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? (newDesigns() ? favoritesAtOpen : local.model.favorite()) : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const model = models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        const provider = providers().get(model.providerID)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: provider?.name ?? model.providerID,
            category,
            footer: trailing(model, isFavorite(item)),
            onSelect: () => {
              props.onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const modelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        .map((model) => {
          const provider = providers().get(model.providerID)
          const value = { providerID: model.providerID, modelID: model.id }
          const favorite = isFavorite(value)
          return {
            value,
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            title: model.name,
            releaseDate: model.time.released,
            description: newDesigns() ? undefined : favorite ? "(Favorite)" : undefined,
            category: connected() ? (freeGroup(model) ? "Free" : (provider?.name ?? model.providerID)) : undefined,
            footer: trailing(model, favorite),
            free: isFreeModel(model),
            onSelect() {
              props.onSelect(model.providerID, model.id)
            },
          }
        })
        .filter((option) => {
          if (!showSections) return true
          if (
            favorites.some(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          )
            return false
          if (
            recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
          )
            return false
          return true
        }),
      connected(),
    )

    if (needle) {
      const results = prioritizeFavorites(
        sortModelOptions(
          fuzzysort.go(needle, modelOptions, { keys: ["title", "category"] }).map((item) => item.obj),
          false,
        ),
        favoritePriority,
      )
      // Search results name the provider inline. Without a category, the trailing slot keeps the favorite marker
      // instead of falling back to the provider name.
      if (!newDesigns()) return results
      return results.map((option) => ({ ...option, description: option.providerName, category: undefined }))
    }

    if (!connected()) return prioritizeFavorites(modelOptions, favoritePriority)

    return [
      ...favoriteOptions,
      ...recentOptions,
      ...modelOptions.filter((option) => option.category !== "Free"),
      ...modelOptions.filter((option) => option.category === "Free"),
    ]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: newDesigns()
            ? connected()
              ? "connect integration"
              : "view all integrations"
            : connected()
              ? "Connect an integration"
              : "View all integrations",
          selection: "none",
          onTrigger: props.onConnect,
        },
        {
          command: "model.dialog.favorite",
          title: newDesigns() ? (option) => (isFavorite(option?.value) ? "unfavorite" : "favorite") : "Favorite",
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}
