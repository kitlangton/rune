import { Effect } from "effect"
import { Tool as AiTool, Toolkit } from "effect/unstable/ai"
import { CodeInput, ExecuteResultSchema, type ExecuteResult, type Rune } from "./rune.js"

type Provide<R> = <A>(effect: Effect.Effect<A, never, R>) => Effect.Effect<A, never, never>

const build = (execute: (code: string) => Effect.Effect<ExecuteResult, never, never>, description: string) => {
  const Code = AiTool.make("code", {
    description,
    parameters: CodeInput,
    success: ExecuteResultSchema,
  })
  const toolkit = Toolkit.make(Code)

  return {
    toolkit,
    layer: toolkit.toLayer({ code: ({ code }) => execute(code) }),
  }
}

/** Adapts a service-free Effect Rune into an Effect AI toolkit and handler layer. */
export const make = (rune: Rune<never>) => {
  const descriptor = rune.asTool()
  return build((code) => descriptor.execute({ code }), descriptor.description)
}

/**
 * Adapts a service-requiring Effect Rune with explicit service provisioning.
 *
 * @example `RuneEffectAi.makeWith(rune, (effect) => effect.pipe(Effect.provide(layer)))`
 */
export const makeWith = <R>(rune: Rune<R>, provide: Provide<R>) => {
  const descriptor = rune.asTool()
  return build((code) => provide(descriptor.execute({ code })), descriptor.description)
}

export * as RuneEffectAi from "./effect-ai.js"
