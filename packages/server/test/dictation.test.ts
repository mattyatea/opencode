import { expect } from "bun:test"
import { Dictation } from "@opencode/core/dictation"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const transcribed: Dictation.TranscribeInput[] = []

// Stands in for the MLX worker, which needs Apple Silicon and a downloaded model.
const dictation = makeLocationNode({
  service: Dictation.Service,
  layer: Layer.succeed(
    Dictation.Service,
    Dictation.Service.of({
      status: () => Effect.succeed({ available: true }),
      languages: () => Effect.succeed(["Japanese", "English"]),
      prepare: () => Effect.fail(new Dictation.UnavailableError({ message: "no python" })),
      transcribe: (input) => {
        transcribed.push(input)
        return Effect.succeed("こんにちは")
      },
      cancel: () => Effect.void,
      cleanup: (input) => Effect.succeed(`cleaned:${input.text}:${input.model?.providerID}/${input.model?.id}`),
    }),
  ),
  deps: [],
})

it.live("serves dictation from the global Location", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-dictation-endpoint-")))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: tmp.path },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Dictation.node.replace(dictation)] },
    )
    const call = (path: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local/api/experimental/dictation/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ).then(async (response) => ({ status: response.status, body: await response.json() })),
      )

    expect(yield* call("status")).toEqual({ status: 200, body: { data: { available: true } } })
    expect(yield* call("languages")).toEqual({ status: 200, body: { data: { languages: ["Japanese", "English"] } } })
    expect((yield* call("prepare", {})).status).toBe(503)

    transcribed.length = 0
    expect(yield* call("transcribe", { session: "a", audio: "", final: true, language: "Japanese" })).toEqual({
      status: 200,
      body: { data: { text: "こんにちは" } },
    })
    expect(transcribed).toEqual([{ session: "a", audio: "", final: true, language: "Japanese" }])

    expect(
      yield* call("cleanup", {
        text: "えっと",
        model: { providerID: "inception", id: "mercury-3", variant: "instant" },
      }),
    ).toEqual({ status: 200, body: { data: { text: "cleaned:えっと:inception/mercury-3" } } })
  }),
)
