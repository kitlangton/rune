import { Effect, Schema } from "effect"
import { CodeInput, Rune, type ExecutionLimits, type ExecuteResult, type ToolDescription } from "./rune.ts"
import type { Policy } from "./policy.ts"
import { isDefinition, Tool, type Definition } from "./tool.ts"
import type { HostTool as EffectHostTool, HostTools } from "./tool-runtime.ts"

export type HostTool = (...args: Array<unknown>) => unknown | PromiseLike<unknown>

export type PromiseTools = {
  [name: string]: HostTool | Definition | PromiseTools
}

export type Options<Tools extends Record<string, unknown> = {}> = {
  readonly tools?: Tools & PromiseTools
  readonly policy?: Policy.Config<Tools>
  readonly requestApproval?: (request: Policy.Request<Policy.CapabilityPath<Tools>>) => boolean | PromiseLike<boolean>
  readonly limits?: ExecutionLimits
}

type RuntimeOptions = {
  readonly tools?: PromiseTools
  readonly policy?: Policy.RuntimeConfig
  readonly requestApproval?: (request: Policy.Request) => boolean | PromiseLike<boolean>
  readonly limits?: ExecutionLimits
}

export type PromiseRune = {
  readonly catalog: () => ReadonlyArray<ToolDescription>
  readonly instructions: () => string
  readonly tool: () => {
    readonly name: "code"
    readonly description: string
    readonly input: typeof CodeInput
    readonly execute: (input: { readonly code: string }) => Promise<ExecuteResult>
  }
  readonly run: (code: string) => Promise<ExecuteResult>
}

type RuntimeTools = Record<string, EffectHostTool | Definition>

const adaptTools = (tools: PromiseTools): HostTools => {
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
  readonly run: (input: I["Type"]) => O["Type"] | PromiseLike<O["Type"]>
}

export const tool = <I extends Schema.Decoder<unknown>, O extends Schema.Decoder<unknown>>(
  options: ToolOptions<I, O>,
): Definition => Tool.make({
  description: options.description,
  input: options.input,
  output: options.output,
  ...(options.approval ? { approval: options.approval } : {}),
  run: (input) => Effect.promise(() => Promise.resolve().then(() => options.run(input))),
})

const makeRuntime = (options: RuntimeOptions): PromiseRune => {
  const tools = adaptTools(options.tools ?? {})
  const requestApproval = options.requestApproval
  const rune = Rune.make<RuntimeTools>({
    tools: tools as RuntimeTools,
    ...(options.policy ? { policy: options.policy as Policy.Config<RuntimeTools> } : {}),
    ...(requestApproval ? {
      requestApproval: (request) => Effect.promise(() => Promise.resolve(requestApproval(request))),
    } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
  const descriptor = rune.tool()
  const run = (code: string) => Effect.runPromise(descriptor.execute({ code }))

  return {
    catalog: rune.catalog,
    instructions: rune.instructions,
    tool: () => ({
      name: descriptor.name,
      description: descriptor.description,
      input: descriptor.input,
      execute: ({ code }) => run(code),
    }),
    run,
  }
}

export const make = <const Tools extends Record<string, unknown> = {}>(options: Options<Tools> = {} as Options<Tools>): PromiseRune => {
  const requestApproval = options.requestApproval
  const policy = options.policy as Policy.RuntimeConfig | undefined
  return makeRuntime({
    ...(options.tools ? { tools: options.tools as PromiseTools } : {}),
    ...(policy ? { policy } : {}),
    ...(requestApproval ? {
      requestApproval: (request) => requestApproval({
        ...request,
        path: request.path as Policy.CapabilityPath<Tools>,
      }),
    } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
}

export const execute = (options: RuntimeOptions & { readonly code: string }): Promise<ExecuteResult> =>
  makeRuntime(options).run(options.code)

export * as RunePromise from "./promise.ts"
