import { Effect, Schema } from "effect"
import { CodeInput, Rune as EffectRune, type ExecutionLimits, type ExecuteResult, type ToolDescription } from "./rune.js"
import type * as Policy from "./policy.js"
import { isDefinition, Tool as EffectTool, type Definition } from "./tool.js"
import type { HostTool as EffectHostTool, HostTools } from "./tool-runtime.js"

type HostTool = (...args: Array<unknown>) => unknown | PromiseLike<unknown>

export type Tools = {
  [name: string]: Definition | Tools
}

type RuntimeToolsInput = {
  [name: string]: HostTool | Definition | RuntimeToolsInput
}

export type Options<RegisteredTools extends Record<string, unknown> = {}> = {
  readonly tools?: RegisteredTools & Tools
  readonly policy?: Policy.Config<RegisteredTools>
  readonly requestApproval?: (request: Policy.Request<Policy.CapabilityPath<RegisteredTools> | Policy.BuiltinPath>) => boolean | PromiseLike<boolean>
  readonly limits?: ExecutionLimits
}

type RuntimeOptions = {
  readonly tools?: RuntimeToolsInput
  readonly policy?: Policy.RuntimeConfig
  readonly requestApproval?: (request: Policy.Request) => boolean | PromiseLike<boolean>
  readonly limits?: ExecutionLimits
}

export type Rune = {
  readonly catalog: () => ReadonlyArray<ToolDescription>
  readonly instructions: () => string
  readonly asTool: () => {
    readonly name: "code"
    readonly description: string
    readonly input: typeof CodeInput
    readonly execute: (input: { readonly code: string }) => Promise<ExecuteResult>
  }
  readonly run: (code: string) => Promise<ExecuteResult>
}

type RuntimeTools = Record<string, EffectHostTool | Definition>

const adaptTools = (tools: RuntimeToolsInput): HostTools => {
  const adapted: HostTools = {}

  for (const [name, tool] of Object.entries(tools)) {
    adapted[name] = isDefinition(tool)
      ? tool
      : typeof tool === "function"
      ? (...args) => Effect.promise(() => Promise.resolve().then(() => tool(...args)))
      : adaptTools(tool)
  }

  return adapted
}

export type ToolOptions<I extends Schema.Decoder<unknown>, O extends Schema.Decoder<unknown>> = {
  readonly description: string
  readonly input: I
  readonly output: O
  readonly approval?: "required"
  readonly run: (input: I["Type"]) => O["Encoded"] | PromiseLike<O["Encoded"]>
}

/** Defines a schema-described capability backed by a value or Promise-returning host function. */
const makeTool = <I extends Schema.Decoder<unknown>, O extends Schema.Decoder<unknown>>(
  options: ToolOptions<I, O>,
): Definition => EffectTool.make({
  description: options.description,
  input: options.input,
  output: options.output,
  ...(options.approval ? { approval: options.approval } : {}),
  run: (input) => Effect.promise(() => Promise.resolve().then(() => options.run(input))),
})

export const Tool = { make: makeTool }

const makeRuntime = (options: RuntimeOptions): Rune => {
  const tools = adaptTools(options.tools ?? {})
  const requestApproval = options.requestApproval
  const rune = EffectRune.make<RuntimeTools>({
    tools: tools as never,
    ...(options.policy ? { policy: options.policy as Policy.Config<RuntimeTools> } : {}),
    ...(requestApproval ? {
      requestApproval: (request) => Effect.promise(() => Promise.resolve(requestApproval(request))),
    } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
  const descriptor = rune.asTool()
  const run = (code: string) => Effect.runPromise(descriptor.execute({ code }))

  return {
    catalog: rune.catalog,
    instructions: rune.instructions,
    asTool: () => ({
      name: descriptor.name,
      description: descriptor.description,
      input: descriptor.input,
      execute: ({ code }) => run(code),
    }),
    run,
  }
}

/**
 * Creates a Promise-facing Rune runtime.
 *
 * @example
 * ```ts
 * const rune = Rune.make({ tools: { orders: { lookup } } })
 * const result = await rune.run(`return await tools.orders.lookup({ id: "order_42" })`)
 * ```
 */
export const make = <const RegisteredTools extends Record<string, unknown> = {}>(options: Options<RegisteredTools> = {} as Options<RegisteredTools>): Rune => {
  const requestApproval = options.requestApproval
  const policy = options.policy as Policy.RuntimeConfig | undefined
  return makeRuntime({
    ...(options.tools ? { tools: options.tools as RuntimeToolsInput } : {}),
    ...(policy ? { policy } : {}),
    ...(requestApproval ? {
      requestApproval: (request) => requestApproval({
        ...request,
        path: request.path as Policy.CapabilityPath<RegisteredTools> | Policy.BuiltinPath,
      }),
    } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
}

export const execute = <const RegisteredTools extends Record<string, unknown> = {}>(options: Options<RegisteredTools> & { readonly code: string }): Promise<ExecuteResult> =>
  make(options).run(options.code)

export const Rune = { make, execute }

export { CodeInput, ExecuteResultSchema } from "./rune.js"
export type { DiagnosticKind, ExecuteResult, ExecutionLimits, ToolCall, ToolDescription } from "./rune.js"
