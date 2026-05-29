import { Clock as EffectClock, Effect, Schema } from "effect"
import { Tool } from "./tool.ts"

export type Options = {
  readonly maxSleepMs?: number
}

export const make = (options: Options = {}) => {
  const maxSleepMs = options.maxSleepMs ?? 1_000

  return {
    now: Tool.make({
      description: "Get the current time",
      input: Schema.Struct({}),
      output: Schema.Struct({ epochMs: Schema.Number, iso: Schema.String }),
      run: () => Effect.map(EffectClock.currentTimeMillis, (epochMs) => ({
        epochMs,
        iso: new Date(epochMs).toISOString(),
      })),
    }),
    sleep: Tool.make({
      description: `Wait for up to ${maxSleepMs} milliseconds`,
      input: Schema.Struct({ ms: Schema.Number }),
      output: Schema.Struct({ elapsedMs: Schema.Number }),
      run: ({ ms }) => Effect.gen(function*() {
        if (!Number.isFinite(ms) || ms < 0 || ms > maxSleepMs) {
          throw new Error(`clock.sleep ms must be between 0 and ${maxSleepMs}.`)
        }
        const started = yield* EffectClock.currentTimeMillis
        yield* Effect.sleep(ms)
        const completed = yield* EffectClock.currentTimeMillis
        return { elapsedMs: completed - started }
      }),
    }),
  }
}

export * as Clock from "./clock.ts"
