import { Effect } from "effect"
import { jsonSchema, type Tool as AiTool } from "ai"
import { type ExecuteResult } from "./rune.js"

type RuneCodeTool = {
  readonly asTool: () => {
    readonly description: string
    readonly execute: (input: { readonly code: string }) => PromiseLike<ExecuteResult> | Effect.Effect<ExecuteResult, never, never>
  }
}

/** Adapts a Promise Rune or service-free Effect Rune to a Vercel AI SDK `code` tool. */
export const make = (rune: RuneCodeTool): AiTool<{ readonly code: string }, ExecuteResult> => {
  const code = rune.asTool()

  return {
    description: code.description,
    inputSchema: jsonSchema<{ readonly code: string }>({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: ({ code: source }) => {
      const execution = code.execute({ code: source })
      return Effect.isEffect(execution) ? Effect.runPromise(execution) : Promise.resolve(execution)
    },
  }
}

/**
 * Adapts a service-requiring Effect Rune by accepting an explicit Promise execution boundary.
 *
 * @example `RuneAiSdk.makeEffect(rune, (effect) => Effect.runPromise(effect.pipe(Effect.provide(layer))))`
 */
export const makeEffect = <R>(rune: {
  readonly asTool: () => {
    readonly description: string
    readonly execute: (input: { readonly code: string }) => Effect.Effect<ExecuteResult, never, R>
  }
}, provide: (effect: Effect.Effect<ExecuteResult, never, R>) => Promise<ExecuteResult>): AiTool<{ readonly code: string }, ExecuteResult> => {
  const code = rune.asTool()
  return {
    description: code.description,
    inputSchema: jsonSchema<{ readonly code: string }>({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: ({ code: source }) => provide(code.execute({ code: source })),
  }
}

export * as RuneAiSdk from "./ai-sdk.js"
