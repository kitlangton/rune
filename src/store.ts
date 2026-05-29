import { Effect, Schema } from "effect"
import { Tool } from "./tool.js"
import { dataByteLength } from "./tool-runtime.js"
import { capabilityError } from "./capability-error.js"

export type Options = {
  readonly maxKeys?: number
  readonly maxBytes?: number
  readonly approval?: "required"
}

/**
 * Creates bounded memory scoped to this pack instance and shared across its Rune runs.
 * Construct a new instance per session when state must be isolated.
 *
 * @example `Store.memory({ maxBytes: 64_000, approval: "required" })`
 */
export const memory = (options: Options = {}) => {
  const values = new Map<string, unknown>()
  const maxKeys = options.maxKeys ?? 1_000
  const maxBytes = options.maxBytes ?? 1_000_000
  const sizes = new Map<string, number>()
  let storedBytes = 0

  if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) throw new Error("store maxKeys must be a positive safe integer.")
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("store maxBytes must be a positive safe integer.")

  return {
    get: Tool.make({
      description: "Read a value from session storage",
      input: Schema.Struct({ key: Schema.String }),
      output: Schema.Struct({ value: Schema.Unknown }),
      run: ({ key }) => Effect.succeed({ value: values.has(key) ? values.get(key) : null }),
    }),
    put: Tool.make({
      description: "Write a value to session storage",
      input: Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
      output: Schema.Struct({ stored: Schema.Boolean }),
      ...(options.approval ? { approval: options.approval } : {}),
      run: ({ key, value }) => Effect.sync(() => {
        if (!values.has(key) && values.size >= maxKeys) {
          throw capabilityError(`store exceeds its maximum key count of ${maxKeys}.`)
        }
        const size = dataByteLength({ key, value })
        const nextBytes = storedBytes - (sizes.get(key) ?? 0) + size
        if (nextBytes > maxBytes) {
          throw capabilityError(`store exceeds its maximum retained size of ${maxBytes} bytes.`)
        }
        values.set(key, value)
        sizes.set(key, size)
        storedBytes = nextBytes
        return { stored: true }
      }),
    }),
    delete: Tool.make({
      description: "Delete a value from session storage",
      input: Schema.Struct({ key: Schema.String }),
      output: Schema.Struct({ deleted: Schema.Boolean }),
      ...(options.approval ? { approval: options.approval } : {}),
      run: ({ key }) => Effect.sync(() => {
        const deleted = values.delete(key)
        if (deleted) {
          storedBytes -= sizes.get(key) ?? 0
          sizes.delete(key)
        }
        return { deleted }
      }),
    }),
    list: Tool.make({
      description: "List session storage keys",
      input: Schema.Struct({}),
      output: Schema.Struct({ keys: Schema.Array(Schema.String) }),
      run: () => Effect.sync(() => ({ keys: Array.from(values.keys()).sort() })),
    }),
  }
}

export * as Store from "./store.js"
