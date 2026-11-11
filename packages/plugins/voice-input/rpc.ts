import { Schema } from "effect"
import { Rpc } from "@opencode/plugin/rpc"

const Failure = Schema.toStandardSchemaV1(Schema.Struct({ log: Schema.String }))

/** The voice input plugin's server contract, shared by its server part and its window part. */
export const Dictation = Rpc.define({
  id: "voice-input",
  methods: {
    /** Starts the local transcription worker and loads the model, downloading it on first use. */
    prepare: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ model: Schema.String })),
      errors: { worker: Failure },
    },
    /**
     * Appends audio to a dictation and returns the transcript of everything it has heard. `audio` is base64
     * little-endian 16-bit mono PCM at 16 kHz. `final` ends the dictation.
     */
    transcribe: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ session: Schema.String, audio: Schema.String, final: Schema.Boolean }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Struct({ text: Schema.String })),
      errors: { worker: Failure },
    },
    /** Drops a dictation's audio without transcribing it. */
    cancel: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ session: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({})),
    },
  },
  events: {},
})
