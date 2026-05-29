import { Schema } from "effect"
import { Tool as AiTool, Toolkit } from "effect/unstable/ai"
import { CodeInput, type Rune } from "./rune.ts"

export const make = (rune: Rune<never>) => {
  const descriptor = rune.tool()
  const Code = AiTool.make("code", {
    description: descriptor.description,
    parameters: CodeInput,
    success: Schema.Unknown,
  })
  const toolkit = Toolkit.make(Code)

  return {
    toolkit,
    layer: toolkit.toLayer({
      code: ({ code }) => descriptor.execute({ code }),
    }),
  }
}

export * as RuneEffectAi from "./effect-ai.ts"
