import { Clock as EffectClock, Effect, Schema } from "effect"
import { Tool } from "./tool.js"
import { capabilityError } from "./capability-error.js"

export type Options = {
  readonly maxSleepMs?: number
}

/**
 * Creates bounded time capabilities: `now` and `sleep`.
 *
 * @example `Clock.make({ maxSleepMs: 250 })`
 */
export const make = (options: Options = {}) => {
  const maxSleepMs = options.maxSleepMs ?? 1_000
  if (!Number.isSafeInteger(maxSleepMs) || maxSleepMs < 0) throw new Error("clock maxSleepMs must be a non-negative safe integer.")

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
          return yield* capabilityError(`clock.sleep ms must be between 0 and ${maxSleepMs}.`)
        }
        const started = yield* EffectClock.currentTimeMillis
        yield* Effect.sleep(ms)
        const completed = yield* EffectClock.currentTimeMillis
        return { elapsedMs: completed - started }
      }),
    }),
  }
}

export * as Clock from "./clock.js"
