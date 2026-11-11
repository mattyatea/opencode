import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Event as ConfigEvent } from "@opencode/schema/config"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginModule } from "@opencode/core/plugin/module"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import { tempGlobalLayer } from "../fixture/global"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

ensurePluginRuntime()

const it = testEffect(
  Layer.mergeAll(
    PluginTestLayer,
    AppNodeBuilder.build(Npm.node, [Global.node.replace(tempGlobalLayer)]),
    Watcher.layer().pipe(Layer.provide(Watcher.nativeLayer)),
  ),
)

// Each Location builds its own PluginModule loader, like each directory booted by the server.
it.live("evaluates an unchanged local plugin once across Locations", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const key = `__sharing_${crypto.randomUUID()}`
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory.path, "index.ts"),
        `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1
        export default { id: "shared", async setup() {} }`,
      ),
    )
    const operation = { type: "add" as const, target: directory.path, options: {} }
    const loaders = yield* Effect.all([PluginModule.make(), PluginModule.make(), PluginModule.make()])
    yield* Effect.all(
      loaders.map((loader) => loader.load(operation)),
      { concurrency: "unbounded" },
    )
    expect((globalThis as Record<string, unknown>)[key]).toBe(1)
  }),
)

it.live("reloads an edited plugin in a Location that reused the shared module", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const entry = path.join(directory.path, "index.ts")
    yield* Effect.promise(() => Bun.write(entry, 'export default { id: "first", async setup() {} }'))
    const operation = { type: "add" as const, target: directory.path, options: {} }
    const owner = yield* PluginModule.make()
    const borrower = yield* PluginModule.make()
    yield* owner.load(operation)
    yield* borrower.load(operation)
    const changed = yield* borrower
      .changes()
      .pipe(Stream.runHead, Effect.timeout("5 seconds"), Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() => Bun.write(entry, 'export default { id: "second", async setup() {} }'))
    yield* Fiber.join(changed)
    expect(yield* borrower.load(operation)).toMatchObject({ id: "second" })
    expect(yield* owner.load(operation)).toMatchObject({ id: "second" })
  }),
)

// The bus is process-wide. A plugin running in one Location must not see another Location's events, or every
// booted directory reacts to the same session settling.
it.live("delivers only its own Location's events to a config plugin", () =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const plugins = yield* Plugin.Service
    const seen = new Array<string>()
    const subscribed = yield* Deferred.make<void>()
    const own = yield* Deferred.make<void>()
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    yield* plugins.activate([
      {
        ...PluginPromise.fromPromise({
          id: "location-events",
          async setup(ctx) {
            const events = ctx.event.subscribe({ types: ["config.updated"], signal: controller.signal })
            const iterator = events[Symbol.asyncIterator]()
            const next = iterator.next()
            Effect.runSync(Deferred.succeed(subscribed, undefined))
            void next.then(async function read(result): Promise<void> {
              if (result.done) return
              seen.push(result.value.location?.directory ?? "global")
              if (result.value.location?.directory === location.directory) Effect.runSync(Deferred.succeed(own, undefined))
              return iterator.next().then(read)
            })
          },
        }),
        revision: "test",
      },
    ])
    yield* plugins.awaitActivation
    yield* Deferred.await(subscribed)
    yield* Effect.sleep("20 millis")
    const other = Location.Ref.make({ directory: AbsolutePath.make("/some/other/location") })
    yield* bus.publish(ConfigEvent.Updated, {}, { location: other })
    yield* bus.publish(ConfigEvent.Updated, {})
    yield* Deferred.await(own).pipe(Effect.timeout("5 seconds"))
    expect(seen).toEqual([location.directory])
  }),
)
