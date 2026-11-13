import { builtinCatalog } from "@opencode/plugin/gui/builtin"
import { Plugin, Store } from "@opencode/plugin/gui"
import { Schema } from "effect"
import en from "./i18n/en"

export default Plugin.define({
  stores: {
    // Whether meters show the used or the remaining share.
    display: Store.global(Schema.Struct({ mode: Schema.Literals(["used", "remaining"]) }), { mode: "used" }, "display"),
  },
  i18n: builtinCatalog({
    en,
    ja: () => import("./i18n/ja"),
  }),
})
