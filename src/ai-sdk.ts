import { Effect } from "effect"
import { jsonSchema, type Tool as AiTool } from "ai"
import { type ExecuteResult, type Rune } from "./rune.ts"

export const make = (rune: Rune<never>): AiTool<{ readonly code: string }, ExecuteResult> => {
  const code = rune.tool()

  return {
    description: code.description,
    inputSchema: jsonSchema<{ readonly code: string }>({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    }),
    execute: ({ code: source }) => Effect.runPromise(code.execute({ code: source })),
  }
}

export * as RuneAiSdk from "./ai-sdk.ts"
