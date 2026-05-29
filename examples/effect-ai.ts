import { Effect, Stream } from "effect"
import { RuneEffectAi } from "../src/effect-ai.ts"
import { agentCode, rune } from "./shared.ts"

const code = RuneEffectAi.make(rune)

const result = await Effect.runPromise(
  Effect.gen(function*() {
    const toolkit = yield* code.toolkit
    const output = yield* toolkit.handle("code", { code: agentCode })
    const results = yield* Stream.runCollect(output)
    return results[0]?.result
  }).pipe(Effect.provide(code.layer)),
)

console.log(JSON.stringify(result, null, 2))
