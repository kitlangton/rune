import { parse } from "acorn"
import { Cause, Effect, Schema } from "effect"
import { DiagnosticCategory, ModuleKind, ScriptTarget, flattenDiagnosticMessageText, transpileModule } from "typescript"
import {
  ToolReference,
  copyIn,
  copyOut,
  dataByteLength,
  isBlockedMember,
  ToolRuntime,
  ToolRuntimeError,
  type HostTools,
  type SafeObject,
  type ToolCall,
  type ToolDescription,
  type Services,
} from "./tool-runtime.ts"
import type { Policy, RequestApproval } from "./policy.ts"

export type { HostTool, HostTools, ToolCall, ToolDescription } from "./tool-runtime.ts"

export type ExecutionLimits = {
  readonly maxOperations?: number
  readonly maxToolCalls?: number
  readonly maxConcurrency?: number
  readonly maxSourceBytes?: number
  readonly maxDataBytes?: number
  readonly maxAuditBytes?: number
  readonly maxValueDepth?: number
  readonly maxCollectionLength?: number
  readonly timeoutMs?: number
}

type ResolvedExecutionLimits = {
  readonly maxOperations: number
  readonly maxToolCalls: number
  readonly maxConcurrency: number
  readonly maxSourceBytes: number
  readonly maxDataBytes: number
  readonly maxAuditBytes: number
  readonly maxValueDepth: number
  readonly maxCollectionLength: number
  readonly timeoutMs: number
}

export type ExecuteOptions<Tools extends Record<string, unknown> = {}, RA = never> = {
  code: string
  tools?: Tools & HostTools<any>
  policy?: Policy.Config<Tools>
  requestApproval?: RequestApproval<Policy.CapabilityPath<Tools>, RA>
  limits?: ExecutionLimits
}

export type ExecuteResult =
  | {
      ok: true
      value: unknown
      toolCalls: Array<ToolCall>
    }
  | {
      ok: false
      error: {
        kind: DiagnosticKind
        message: string
        location?: { readonly line: number; readonly column: number }
        suggestions?: ReadonlyArray<string>
      }
      toolCalls: Array<ToolCall>
    }

export type RuneOptions<Tools extends Record<string, unknown> = {}, RA = never> = Omit<ExecuteOptions<Tools, RA>, "code">

export const CodeInput = Schema.Struct({ code: Schema.String })

export type CodeTool<R = never> = {
  readonly name: "code"
  readonly description: string
  readonly input: typeof CodeInput
  readonly execute: (input: { readonly code: string }) => Effect.Effect<ExecuteResult, never, R>
}

export type Rune<R = never> = {
  readonly catalog: () => ReadonlyArray<ToolDescription>
  readonly instructions: () => string
  readonly tool: () => CodeTool<R>
  readonly run: (code: string) => Effect.Effect<ExecuteResult, never, R>
}

type SourcePosition = {
  line: number
  column: number
}

type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

type ProgramNode = AstNode & {
  type: "Program"
  body: Array<AstNode>
}

type Binding = {
  mutable: boolean
  value: unknown
}

type StatementResult =
  | { kind: "none" }
  | { kind: "value"; value: unknown }
  | { kind: "return"; value: unknown }
  | { kind: "break" }
  | { kind: "continue" }

type MemberReference = {
  target: SafeObject | Array<unknown>
  key: string | number
}

class RuneFunction {
  constructor(
    readonly parameters: ReadonlyArray<AstNode>,
    readonly body: AstNode,
    readonly capturedScopes: ReadonlyArray<Map<string, Binding>>,
  ) {}
}

class IntrinsicReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

// A read-only computed member (e.g. `str.length`, a character index) — not assignable.
class ComputedValue {
  constructor(readonly value: unknown) {}
}

class PromiseNamespace {}

class PromiseAllReference {}

// A built-in global namespace (`Object`, `Math`, `JSON`, `Array`); members resolve to a
// GlobalMethodReference, except known constants (e.g. `Math.PI`) which resolve to a value.
class GlobalNamespace {
  constructor(readonly name: "Object" | "Math" | "JSON" | "Array") {}
}

class GlobalMethodReference {
  constructor(readonly namespace: "Object" | "Math" | "JSON" | "Array", readonly name: string) {}
}

// A built-in callable global (`Number`, `String`, `Boolean`, `parseInt`, `parseFloat`).
class CoercionFunction {
  constructor(readonly name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat") {}
}

class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export type DiagnosticKind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "UnknownCapability"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "OperationLimitExceeded"
  | "ToolCallLimitExceeded"
  | "AuditLimitExceeded"
  | "ConcurrencyLimitExceeded"
  | "TimeoutExceeded"
  | "CapabilityDenied"
  | "ApprovalDenied"
  | "ExecutionFailure"

const arrayMethods = new Set([
  "map", "filter", "find", "findIndex", "some", "every", "includes", "join",
  "reduce", "flatMap", "forEach", "sort", "slice", "concat", "indexOf", "lastIndexOf",
  "at", "flat", "reverse",
])
const retryableArrayMethods = new Set(["splice", "fill", "copyWithin", "reduceRight", "keys", "values", "entries"])

const mathConstants = new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"])

const stringMethods = new Set([
  "toLowerCase", "toUpperCase", "trim", "trimStart", "trimEnd", "split", "slice",
  "includes", "startsWith", "endsWith", "indexOf", "lastIndexOf", "replace", "replaceAll",
  "repeat", "padStart", "padEnd", "charAt", "at", "concat",
])

const OptionalShortCircuit: unique symbol = Symbol("rune.optional-short-circuit")

const supportedSyntaxMessage =
  "Supported orchestration syntax: tools.* calls, data literals, destructuring, optional chaining, template literals, conditionals, switch, loops, arrow functions, spread, try/catch, array methods (map/filter/find/findIndex/some/every/reduce/flatMap/forEach/sort/slice/concat/indexOf/lastIndexOf/at/flat/reverse/includes/join), string methods, Object/Math/JSON helpers, and Promise.all([tool calls]) or Promise.all(items.map((item) => tool call)) for parallel tool calls."

const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(`Syntax '${kind}' is not supported in Rune. ${supportedSyntaxMessage}`, node, "UnsupportedSyntax", [supportedSyntaxMessage])

export const defaultExecutionLimits = (): ResolvedExecutionLimits => ({
  maxOperations: 100_000,
  maxToolCalls: 100,
  maxConcurrency: 8,
  maxSourceBytes: 32_000,
  maxDataBytes: 256_000,
  maxAuditBytes: 1_000_000,
  maxValueDepth: 32,
  maxCollectionLength: 10_000,
  timeoutMs: 10_000,
})

export const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  ...defaultExecutionLimits(),
  ...limits,
})

class InterpreterRuntimeError extends Error {
  readonly node?: AstNode

  constructor(message: string, node?: AstNode, readonly kind: DiagnosticKind = "ExecutionFailure", readonly suggestions?: ReadonlyArray<string>) {
    super(message)
    this.name = "InterpreterRuntimeError"

    if (node) {
      this.node = node
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const asNode = (value: unknown, context: string): AstNode => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`)
  }

  return value as AstNode
}

const getArray = (node: AstNode, key: string): Array<unknown> => {
  const value = node[key]
  if (!Array.isArray(value)) {
    throw new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node)
  }

  return value
}

const getString = (node: AstNode, key: string): string => {
  const value = node[key]
  if (typeof value !== "string") {
    throw new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node)
  }

  return value
}

const getBoolean = (node: AstNode, key: string): boolean => {
  const value = node[key]
  if (typeof value !== "boolean") {
    throw new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node)
  }

  return value
}

const getOptionalNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key]
  if (value === undefined || value === null) {
    return undefined
  }

  return asNode(value, key)
}

const getNode = (node: AstNode, key: string): AstNode => {
  const value = node[key]
  return asNode(value, key)
}

const parseProgram = (code: string): ProgramNode => {
  const transpiled = transpileModule(`async function __rune__() {\n${code}\n}`, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
    },
  })
  const diagnostic = transpiled.diagnostics?.find((item) => item.category === DiagnosticCategory.Error)

  if (diagnostic) {
    throw new InterpreterRuntimeError(
      `Failed to parse TypeScript: ${flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
      undefined,
      "ParseError",
    )
  }

  const bodyStart = transpiled.outputText.indexOf("{") + 1
  const bodyEnd = transpiled.outputText.lastIndexOf("}")
  const executableCode = transpiled.outputText.slice(bodyStart, bodyEnd)
  const parsed = parse(executableCode, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  }) as unknown

  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body)) {
    throw new InterpreterRuntimeError("Failed to parse script as a Program node.")
  }

  return parsed as ProgramNode
}

const formatLocation = (node?: AstNode): string => {
  if (!node || !node.loc) {
    return ""
  }

  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}

const sourceLocation = (node: AstNode): { readonly line: number; readonly column: number } => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
})

type Diagnostic = Extract<ExecuteResult, { ok: false }>['error']

const publicErrorMessage = (message: string): string =>
  message.replace(/\/(?:Users|home|private|tmp|var\/folders)\/[^\s"'`]+/g, "<redacted-path>")

const normalizeError = (error: unknown): Diagnostic => {
  if (error instanceof InterpreterRuntimeError) {
    return {
      kind: error.kind,
      message: `${error.message}${formatLocation(error.node)}`,
      ...(error.node?.loc ? { location: sourceLocation(error.node) } : {}),
      ...(error.suggestions ? { suggestions: error.suggestions } : {}),
    }
  }

  if (error instanceof ToolRuntimeError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.suggestions.length > 0 ? { suggestions: error.suggestions } : {}),
    }
  }

  if (error instanceof RangeError && /call stack|recursion/i.test(error.message)) {
    return {
      kind: "ExecutionFailure",
      message: "Execution exceeded the maximum nesting depth.",
    }
  }

  if (error instanceof Error) {
    return {
      kind: error.name === "SyntaxError" ? "ParseError" : "ExecutionFailure",
      message: publicErrorMessage(error.message),
    }
  }

  return {
    kind: "ExecutionFailure",
    message: String(error),
  }
}

// ── Built-in method/global implementations ───────────────────────────────────
// These mirror the corresponding JavaScript operations over Data Values. They are
// pure (string/Object/Math/JSON/coercion) and so live as free functions; array
// methods that run Rune callbacks live on the interpreter (they need invokeFunction).

const boundedData = (value: unknown, label: string, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  const copied = copyIn(value, label, limits)
  if (dataByteLength(copied) > limits.maxDataBytes) {
    throw new InterpreterRuntimeError(`${label} exceeds the maximum data size of ${limits.maxDataBytes} bytes.`, node, "InvalidDataValue")
  }
  return copied
}

const isRuntimeReference = (value: unknown): boolean =>
    value instanceof RuneFunction || value instanceof ToolReference || value instanceof IntrinsicReference ||
    value instanceof GlobalNamespace || value instanceof GlobalMethodReference || value instanceof PromiseNamespace ||
    value instanceof PromiseAllReference || value instanceof CoercionFunction

const containsRuntimeReference = (value: unknown, seen = new Set<object>()): boolean => {
  if (isRuntimeReference(value)) return true
  if (value === null || typeof value !== "object") return false
  if (seen.has(value)) return false
  seen.add(value)
  const contains = Array.isArray(value)
    ? value.some((item) => containsRuntimeReference(item, seen))
    : Object.values(value).some((item) => containsRuntimeReference(item, seen))
  seen.delete(value)
  return contains
}

const runtimeValueBytes = (
  value: unknown,
  label: string,
  node: AstNode,
  limits: ResolvedExecutionLimits,
  depth = 0,
  seen = new Set<object>(),
): number => {
  if (depth > limits.maxValueDepth) {
    throw new InterpreterRuntimeError(`${label} exceeds the maximum value depth of ${limits.maxValueDepth}.`, node, "InvalidDataValue")
  }
  if (isRuntimeReference(value)) return 0
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return dataByteLength(value)
  }
  if (typeof value !== "object") {
    throw new InterpreterRuntimeError(`${label} must contain data or Rune references only.`, node, "InvalidDataValue")
  }
  if (seen.has(value)) throw new InterpreterRuntimeError(`${label} contains a circular value.`, node, "InvalidDataValue")
  seen.add(value)
  let bytes = 2
  if (Array.isArray(value)) {
    if (value.length > limits.maxCollectionLength) {
      throw new InterpreterRuntimeError(`${label} exceeds the maximum collection length of ${limits.maxCollectionLength}.`, node, "InvalidDataValue")
    }
    for (const item of value) bytes += runtimeValueBytes(item, label, node, limits, depth + 1, seen) + 1
  } else {
    const entries = Object.entries(value)
    if (entries.length > limits.maxCollectionLength) {
      throw new InterpreterRuntimeError(`${label} exceeds the maximum collection length of ${limits.maxCollectionLength}.`, node, "InvalidDataValue")
    }
    for (const [key, item] of entries) {
      if (isBlockedMember(key)) throw new InterpreterRuntimeError(`${label} contains blocked property '${key}'.`, node, "InvalidDataValue")
      bytes += dataByteLength(key) + runtimeValueBytes(item, label, node, limits, depth + 1, seen) + 1
    }
  }
  seen.delete(value)
  return bytes
}

const boundedProgramValue = (value: unknown, label: string, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  if (runtimeValueBytes(value, label, node, limits) > limits.maxDataBytes) {
    throw new InterpreterRuntimeError(`${label} exceeds the maximum data size of ${limits.maxDataBytes} bytes.`, node, "InvalidDataValue")
  }
  return value
}

const invokeStringMethod = (value: string, name: string, args: Array<unknown>, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  const str = (index: number): string => {
    const arg = args[index]
    if (typeof arg !== "string") throw new InterpreterRuntimeError(`String.${name} expects argument ${index + 1} to be a string.`, node)
    return arg
  }
  const num = (index: number): number => {
    const arg = args[index]
    if (typeof arg !== "number") throw new InterpreterRuntimeError(`String.${name} expects argument ${index + 1} to be a number.`, node)
    return arg
  }
  const optNum = (index: number): number | undefined => (args[index] === undefined ? undefined : num(index))
  const optStr = (index: number): string | undefined => (args[index] === undefined ? undefined : str(index))
  const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength
  const limitString = (bytes: number): void => {
    if (bytes > limits.maxDataBytes) {
      throw new InterpreterRuntimeError(`String.${name} exceeds the maximum data size of ${limits.maxDataBytes} bytes.`, node, "InvalidDataValue")
    }
  }
  const replacementCount = (search: string): number => {
    if (search === "") return value.length + 1
    let count = 0
    let offset = 0
    while ((offset = value.indexOf(search, offset)) !== -1) {
      count += 1
      offset += search.length
    }
    return count
  }

  let result: unknown
  switch (name) {
    case "toLowerCase": result = value.toLowerCase(); break
    case "toUpperCase": result = value.toUpperCase(); break
    case "trim": result = value.trim(); break
    case "trimStart": result = value.trimStart(); break
    case "trimEnd": result = value.trimEnd(); break
    case "split": {
      if (args.length === 0) {
        result = [value]
        break
      }
      const separator = str(0)
      const requestedLimit = optNum(1)
      const effectiveLimit = requestedLimit === undefined ? undefined : requestedLimit >>> 0
      const maximumParts = separator === "" ? value.length : replacementCount(separator) + 1
      const parts = effectiveLimit === undefined ? maximumParts : Math.min(maximumParts, effectiveLimit)
      if (parts > limits.maxCollectionLength) {
        throw new InterpreterRuntimeError(`String.split exceeds the maximum collection length of ${limits.maxCollectionLength}.`, node, "InvalidDataValue")
      }
      result = value.split(separator, effectiveLimit)
      break
    }
    case "slice": result = value.slice(optNum(0), optNum(1)); break
    case "includes": result = value.includes(str(0), optNum(1)); break
    case "startsWith": result = value.startsWith(str(0), optNum(1)); break
    case "endsWith": result = value.endsWith(str(0), optNum(1)); break
    case "indexOf": result = value.indexOf(str(0), optNum(1)); break
    case "lastIndexOf": result = value.lastIndexOf(str(0), optNum(1)); break
    case "replace": result = value.replace(str(0), str(1)); break
    case "replaceAll": {
      const search = str(0)
      const replacement = str(1)
      const growth = Math.max(0, byteLength(replacement) - byteLength(search))
      limitString(byteLength(value) + replacementCount(search) * growth)
      result = value.replaceAll(search, replacement)
      break
    }
    case "repeat": {
      const count = num(0)
      if (!Number.isFinite(count) || count < 0) throw new InterpreterRuntimeError("String.repeat expects a finite non-negative count.", node)
      limitString(byteLength(value) * Math.floor(count))
      result = value.repeat(count)
      break
    }
    case "padStart": {
      const length = num(0)
      limitString(Math.max(0, length))
      result = value.padStart(length, optStr(1))
      break
    }
    case "padEnd": {
      const length = num(0)
      limitString(Math.max(0, length))
      result = value.padEnd(length, optStr(1))
      break
    }
    case "charAt": result = value.charAt(num(0)); break
    case "at": result = value.at(num(0)); break
    case "concat": {
      const pieces = args.map((_, index) => str(index))
      limitString(byteLength(value) + pieces.reduce((size, piece) => size + byteLength(piece), 0))
      result = value.concat(...pieces)
      break
    }
    default: throw new InterpreterRuntimeError(`String method '${name}' is not available in Rune.`, node)
  }
  return boundedData(result, `String.${name} result`, node, limits)
}

// JavaScript's String(...) without tripping over Rune's null-prototype data objects.
const coerceToString = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "object") {
    return Array.isArray(value)
      ? value.map((item) => (item === null || item === undefined ? "" : coerceToString(item))).join(",")
      : "[object Object]"
  }
  return String(value)
}

const coerceToNumber = (value: unknown): number =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? Number.NaN : Number(value)

const invokeCoercion = (ref: CoercionFunction, args: Array<unknown>, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  const value = boundedData(args[0], `${ref.name} input`, node, limits)
  if (ref.name === "Number") return coerceToNumber(value)
  if (ref.name === "Boolean") return Boolean(value)
  if (ref.name === "parseInt") {
    const radix = args[1]
    if (radix !== undefined && typeof radix !== "number") throw new InterpreterRuntimeError("parseInt expects a numeric radix.", node)
    return parseInt(coerceToString(value), radix)
  }
  if (ref.name === "parseFloat") return parseFloat(coerceToString(value))
  return coerceToString(value)
}

const invokeObjectMethod = (name: string, args: Array<unknown>, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  const requireObject = (): Record<string, unknown> => {
    const value = boundedData(args[0], `Object.${name} input`, node, limits)
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new InterpreterRuntimeError(`Object.${name} expects a data object.`, node)
    }
    return value as Record<string, unknown>
  }
  const guardedSet = (out: Record<string, unknown>, key: string, item: unknown): void => {
    if (isBlockedMember(key)) throw new InterpreterRuntimeError(`Property '${key}' is not available in Rune.`, node)
    out[key] = item
  }
  switch (name) {
    case "keys": return Object.keys(requireObject())
    case "values": return Object.values(requireObject())
    case "entries": return Object.entries(requireObject()).map(([key, item]) => [key, item])
    case "assign": {
      const out: Record<string, unknown> = Object.create(null)
      for (const source of args) {
        if (source === null || source === undefined) continue
        const value = boundedData(source, "Object.assign input", node, limits)
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InterpreterRuntimeError("Object.assign expects data objects.", node)
        for (const [key, item] of Object.entries(value)) guardedSet(out, key, item)
      }
      return out
    }
    case "fromEntries": {
      const pairs = boundedData(args[0], "Object.fromEntries input", node, limits)
      if (!Array.isArray(pairs)) throw new InterpreterRuntimeError("Object.fromEntries expects an array of [key, value] pairs.", node)
      const out: Record<string, unknown> = Object.create(null)
      for (const pair of pairs) {
        if (!Array.isArray(pair)) throw new InterpreterRuntimeError("Object.fromEntries expects [key, value] pairs.", node)
        guardedSet(out, String(pair[0]), pair[1])
      }
      return out
    }
    default: throw new InterpreterRuntimeError(`Object.${name} is not available in Rune.`, node)
  }
}

const invokeMathMethod = (name: string, args: Array<unknown>, node: AstNode): number => {
  const nums = args.map((arg) => {
    if (typeof arg !== "number") throw new InterpreterRuntimeError(`Math.${name} expects number arguments.`, node)
    return arg
  })
  const [a = Number.NaN, b = Number.NaN] = nums
  switch (name) {
    case "max": return Math.max(...nums)
    case "min": return Math.min(...nums)
    case "abs": return Math.abs(a)
    case "floor": return Math.floor(a)
    case "ceil": return Math.ceil(a)
    case "round": return Math.round(a)
    case "trunc": return Math.trunc(a)
    case "sign": return Math.sign(a)
    case "sqrt": return Math.sqrt(a)
    case "cbrt": return Math.cbrt(a)
    case "pow": return Math.pow(a, b)
    case "hypot": return Math.hypot(...nums)
    case "log": return Math.log(a)
    case "log2": return Math.log2(a)
    case "log10": return Math.log10(a)
    case "exp": return Math.exp(a)
    default: throw new InterpreterRuntimeError(`Math.${name} is not available in Rune.`, node)
  }
}

const invokeJsonMethod = (name: string, args: Array<unknown>, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  switch (name) {
    case "stringify": {
      const replacer = args[1]
      if (Array.isArray(replacer) || replacer instanceof RuneFunction) {
        throw new InterpreterRuntimeError("JSON.stringify replacers are not supported in Rune.", node, "UnsupportedSyntax", [supportedSyntaxMessage])
      }
      const space = args[2]
      const indent = typeof space === "number" || typeof space === "string" ? space : undefined
      // copyIn first so only Data Values serialize — never a RuneFunction/ToolReference.
      return JSON.stringify(copyOut(copyIn(args[0], "JSON.stringify value", limits)), null, indent)
    }
    case "parse": {
      const text = args[0]
      if (typeof text !== "string") throw new InterpreterRuntimeError("JSON.parse expects a string.", node)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new InterpreterRuntimeError("JSON.parse received invalid JSON.", node)
      }
      return copyIn(parsed, "JSON.parse result", limits)
    }
    default: throw new InterpreterRuntimeError(`JSON.${name} is not available in Rune.`, node)
  }
}

const invokeArrayStatic = (name: string, args: Array<unknown>, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  switch (name) {
    case "isArray":
      return Array.isArray(args[0])
    case "of":
      return [...args]
    case "from": {
      if (args.length > 1) {
        throw new InterpreterRuntimeError(
          "Array.from(...) does not support a map function in Rune; call .map() on the result instead.",
          node,
          "UnsupportedSyntax",
          [supportedSyntaxMessage],
        )
      }
      const source = boundedData(args[0], "Array.from input", node, limits)
      if (typeof source === "string") return Array.from(source)
      if (Array.isArray(source)) return [...source]
      if (source !== null && typeof source === "object" && typeof (source as { length?: unknown }).length === "number") {
        return Array.from(source as ArrayLike<unknown>)
      }
      throw new InterpreterRuntimeError("Array.from expects an array, string, or array-like value.", node)
    }
    default:
      throw new InterpreterRuntimeError(`Array.${name} is not available in Rune.`, node)
  }
}

const invokeGlobalMethod = (ref: GlobalMethodReference, args: Array<unknown>, node: AstNode, limits: ResolvedExecutionLimits): unknown => {
  if (ref.namespace === "Object") return invokeObjectMethod(ref.name, args, node, limits)
  if (ref.namespace === "Math") return invokeMathMethod(ref.name, args, node)
  if (ref.namespace === "Array") return invokeArrayStatic(ref.name, args, node, limits)
  return invokeJsonMethod(ref.name, args, node, limits)
}

class Interpreter<R> {
  private scopes: Array<Map<string, Binding>>
  private readonly limits: ResolvedExecutionLimits
  private readonly invokeTool: (path: ReadonlyArray<string>, args: Array<unknown>) => Effect.Effect<unknown, unknown, R>
  private readonly budget: { operations: number }
  private lastValue: unknown

  constructor(
    limits: ResolvedExecutionLimits,
    invokeTool: (path: ReadonlyArray<string>, args: Array<unknown>) => Effect.Effect<unknown, unknown, R>,
    budget: { operations: number } = { operations: 0 },
  ) {
    const globalScope = new Map<string, Binding>()
    this.scopes = [globalScope]
    this.limits = limits
    this.invokeTool = invokeTool
    this.budget = budget
    this.lastValue = undefined
    globalScope.set("tools", { mutable: false, value: new ToolReference([]) })
    globalScope.set("Promise", { mutable: false, value: new PromiseNamespace() })
    globalScope.set("Object", { mutable: false, value: new GlobalNamespace("Object") })
    globalScope.set("Math", { mutable: false, value: new GlobalNamespace("Math") })
    globalScope.set("JSON", { mutable: false, value: new GlobalNamespace("JSON") })
    globalScope.set("Number", { mutable: false, value: new CoercionFunction("Number") })
    globalScope.set("String", { mutable: false, value: new CoercionFunction("String") })
    globalScope.set("Boolean", { mutable: false, value: new CoercionFunction("Boolean") })
    globalScope.set("Array", { mutable: false, value: new GlobalNamespace("Array") })
    globalScope.set("parseInt", { mutable: false, value: new CoercionFunction("parseInt") })
    globalScope.set("parseFloat", { mutable: false, value: new CoercionFunction("parseFloat") })
  }

  run(program: ProgramNode): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.gen(function*() {
      for (const statement of program.body) {
        const result = yield* self.evaluateStatement(statement)

        if (result.kind === "return") {
          return result.value
        }

        if (result.kind === "break" || result.kind === "continue") {
          throw new InterpreterRuntimeError(`Unexpected '${result.kind}' outside of a loop.`, statement)
        }

        if (result.kind === "value") {
          self.lastValue = result.value
        }
      }

      return self.lastValue
    })
  }

  private evaluateStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    this.recordOperation(node)

    switch (node.type) {
      case "ExpressionStatement":
        return Effect.map(this.evaluateExpression(getNode(node, "expression")), (value) => ({ kind: "value", value }))
      case "VariableDeclaration":
        return Effect.map(this.evaluateVariableDeclaration(node), () => ({ kind: "none" }))
      case "ReturnStatement": {
        const argumentNode = getOptionalNode(node, "argument")
        return argumentNode
          ? Effect.map(this.evaluateExpression(argumentNode), (value) => ({ kind: "return", value }))
          : Effect.succeed({ kind: "return", value: undefined })
      }
      case "BlockStatement":
        return this.evaluateBlock(node)
      case "IfStatement":
        return this.evaluateIfStatement(node)
      case "SwitchStatement":
        return this.evaluateSwitchStatement(node)
      case "WhileStatement":
        return this.evaluateWhileStatement(node)
      case "DoWhileStatement":
        return this.evaluateDoWhileStatement(node)
      case "ForStatement":
        return this.evaluateForStatement(node)
      case "ForOfStatement":
        return this.evaluateForOfStatement(node)
      case "BreakStatement":
        return Effect.succeed(this.evaluateBreakStatement(node))
      case "ContinueStatement":
        return Effect.succeed(this.evaluateContinueStatement(node))
      case "ThrowStatement":
        return this.evaluateThrowStatement(node)
      case "TryStatement":
        return this.evaluateTryStatement(node)
      case "EmptyStatement":
        return Effect.succeed({ kind: "none" })
      default:
        throw unsupportedSyntax(node.type, node)
    }
  }

  private evaluateBlock(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    this.pushScope()
    const self = this
    return Effect.gen(function*() {
      const body = getArray(node, "body")

      for (const statementValue of body) {
        const statement = asNode(statementValue, "body")
        const result = yield* self.evaluateStatement(statement)

        if (result.kind === "value") {
          self.lastValue = result.value
          continue
        }

        if (result.kind !== "none") {
          return result
        }
      }

      return { kind: "none" } satisfies StatementResult
    }).pipe(Effect.ensuring(Effect.sync(() => self.popScope())))
  }

  private evaluateIfStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    const testNode = getNode(node, "test")
    const consequentNode = getNode(node, "consequent")
    const alternateNode = getOptionalNode(node, "alternate")

    return Effect.flatMap(this.evaluateExpression(testNode), (test) =>
      test ? this.evaluateStatement(consequentNode) : alternateNode ? this.evaluateStatement(alternateNode) : Effect.succeed({ kind: "none" }))
  }

  private evaluateSwitchStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    const self = this
    this.pushScope()
    return Effect.gen(function*() {
      const discriminant = yield* self.evaluateExpression(getNode(node, "discriminant"))
      if (containsRuntimeReference(discriminant)) {
        throw new InterpreterRuntimeError("Switch discriminants must be data values in Rune.", node, "InvalidDataValue")
      }
      const cases = getArray(node, "cases").map((value, index) => asNode(value, `cases[${index}]`))
      let defaultIndex: number | undefined
      let selected: number | undefined
      for (const [index, branch] of cases.entries()) {
        const test = getOptionalNode(branch, "test")
        if (!test) {
          defaultIndex = index
          continue
        }
        const candidate = yield* self.evaluateExpression(test)
        if (containsRuntimeReference(candidate)) {
          throw new InterpreterRuntimeError("Switch case values must be data values in Rune.", test, "InvalidDataValue")
        }
        if (candidate === discriminant) {
          selected = index
          break
        }
      }
      const start = selected ?? defaultIndex
      if (start === undefined) return { kind: "none" } satisfies StatementResult
      for (let index = start; index < cases.length; index += 1) {
        for (const statementValue of getArray(cases[index]!, "consequent")) {
          const result = yield* self.evaluateStatement(asNode(statementValue, "consequent"))
          if (result.kind === "break") return { kind: "none" } satisfies StatementResult
          if (result.kind === "return" || result.kind === "continue") return result
          if (result.kind === "value") self.lastValue = result.value
        }
      }
      return { kind: "none" } satisfies StatementResult
    }).pipe(Effect.ensuring(Effect.sync(() => self.popScope())))
  }

  private evaluateWhileStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    const testNode = getNode(node, "test")
    const bodyNode = getNode(node, "body")

    const self = this
    return Effect.gen(function*() {
      while (yield* self.evaluateExpression(testNode)) {
        const result = yield* self.evaluateStatement(bodyNode)

        if (result.kind === "continue") {
          continue
        }

        if (result.kind === "break") {
        return { kind: "none" } satisfies StatementResult
        }

        if (result.kind === "return") {
          return result
        }

        if (result.kind === "value") {
          self.lastValue = result.value
        }
      }

      return { kind: "none" } satisfies StatementResult
    })
  }

  private evaluateDoWhileStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    const bodyNode = getNode(node, "body")
    const testNode = getNode(node, "test")

    const self = this
    return Effect.gen(function*() {
      do {
        const result = yield* self.evaluateStatement(bodyNode)

        if (result.kind === "continue") {
          continue
        }

        if (result.kind === "break") {
          return { kind: "none" } satisfies StatementResult
        }

        if (result.kind === "return") {
          return result
        }

        if (result.kind === "value") {
          self.lastValue = result.value
        }
      } while (yield* self.evaluateExpression(testNode))

      return { kind: "none" } satisfies StatementResult
    })
  }

  private evaluateForStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    this.pushScope()
    const self = this
    return Effect.gen(function*() {
      const initNode = getOptionalNode(node, "init")
      const testNode = getOptionalNode(node, "test")
      const updateNode = getOptionalNode(node, "update")
      const bodyNode = getNode(node, "body")

      if (initNode) {
        if (initNode.type === "VariableDeclaration") {
          yield* self.evaluateVariableDeclaration(initNode)
        } else {
          yield* self.evaluateExpression(initNode)
        }
      }

      const perIterationBindings = initNode?.type === "VariableDeclaration" && getString(initNode, "kind") !== "var"
        ? Array.from(self.currentScope().keys())
        : []

      while (testNode ? yield* self.evaluateExpression(testNode) : true) {
        let iterationScope: Map<string, Binding> | undefined
        if (perIterationBindings.length > 0) {
          iterationScope = new Map(perIterationBindings.map((name) => {
            const binding = self.currentScope().get(name)!
            return [name, { ...binding }]
          }))
          self.scopes.push(iterationScope)
        }
        const result = yield* self.evaluateStatement(bodyNode).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (iterationScope) self.popScope()
          })),
        )

        if (result.kind === "return") {
          return result
        }

        if (result.kind === "break") {
          return { kind: "none" } satisfies StatementResult
        }

        if (result.kind === "value") {
          self.lastValue = result.value
        }

        if (iterationScope) {
          const loopScope = self.currentScope()
          for (const name of perIterationBindings) {
            loopScope.set(name, { ...iterationScope.get(name)! })
          }
        }

        if (updateNode) {
          yield* self.evaluateExpression(updateNode)
        }

        if (result.kind === "continue") {
          continue
        }
      }

      return { kind: "none" } satisfies StatementResult
    }).pipe(Effect.ensuring(Effect.sync(() => self.popScope())))
  }

  private evaluateForOfStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    if (getBoolean(node, "await")) {
      throw new InterpreterRuntimeError("for await...of is not supported.", node)
    }

    const self = this
    return Effect.gen(function*() {
      const left = getNode(node, "left")
      const right = yield* self.evaluateExpression(getNode(node, "right"))
      const body = getNode(node, "body")

      if (!Array.isArray(right)) {
        throw new InterpreterRuntimeError("for...of requires an array value in Rune.", node)
      }

      let declaration: { readonly pattern: AstNode; readonly mutable: boolean } | undefined
      let assignmentName: string | undefined

      if (left.type === "VariableDeclaration") {
        const declarations = getArray(left, "declarations")
        if (declarations.length !== 1) {
          throw new InterpreterRuntimeError("for...of supports one declared binding.", left)
        }

        const declarator = asNode(declarations[0], "declarations[0]")
        declaration = { pattern: getNode(declarator, "id"), mutable: getString(left, "kind") !== "const" }
      } else if (left.type === "Identifier") {
        assignmentName = getString(left, "name")
      } else {
        throw new InterpreterRuntimeError("Unsupported for...of binding.", left)
      }

      for (const value of right) {
        if (declaration) {
          self.pushScope()
          self.declarePattern(declaration.pattern, value, declaration.mutable, left)
        } else if (assignmentName) {
          self.setIdentifierValue(assignmentName, value, left)
        }

        const result = yield* self.evaluateStatement(body).pipe(
          Effect.ensuring(Effect.sync(() => {
            if (declaration) self.popScope()
          })),
        )

        if (result.kind === "return") {
          return result
        }

        if (result.kind === "break") {
          return { kind: "none" }
        }

        if (result.kind === "value") {
          self.lastValue = result.value
        }

        if (result.kind === "continue") {
          continue
        }
      }

      return { kind: "none" }
    })
  }

  private evaluateBreakStatement(node: AstNode): StatementResult {
    const labelNode = getOptionalNode(node, "label")

    if (labelNode) {
      throw new InterpreterRuntimeError("Labeled break is not supported in v1.", node)
    }

    return { kind: "break" }
  }

  private evaluateContinueStatement(node: AstNode): StatementResult {
    const labelNode = getOptionalNode(node, "label")

    if (labelNode) {
      throw new InterpreterRuntimeError("Labeled continue is not supported in v1.", node)
    }

    return { kind: "continue" }
  }

  private evaluateThrowStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    const argument = getNode(node, "argument")
    return Effect.flatMap(this.evaluateExpression(argument), (value) => Effect.fail(new ProgramThrow(value)))
  }

  private evaluateTryStatement(node: AstNode): Effect.Effect<StatementResult, unknown, R> {
    const body = getNode(node, "block")
    const handler = getOptionalNode(node, "handler")
    const finalizer = getOptionalNode(node, "finalizer")
    const self = this

    const attempted = Effect.matchCauseEffect(this.evaluateStatement(body), {
      onFailure: (cause) => {
        if (cause.reasons.some(Cause.isInterruptReason) || !handler) {
          return Effect.failCause(cause)
        }

        const thrown = Cause.squash(cause)
        const caught = thrown instanceof ProgramThrow
          ? thrown.value
          : Object.assign(Object.create(null) as SafeObject, { message: normalizeError(thrown).message })
        const parameter = getOptionalNode(handler, "param")
        self.pushScope()
        if (parameter) self.declarePattern(parameter, caught, true, handler)
        return self.evaluateStatement(getNode(handler, "body")).pipe(
          Effect.ensuring(Effect.sync(() => self.popScope())),
        )
      },
      onSuccess: Effect.succeed,
    })

    if (!finalizer) return attempted

    const isAbrupt = (result: StatementResult): boolean =>
      result.kind === "return" || result.kind === "break" || result.kind === "continue"

    return Effect.matchCauseEffect(attempted, {
      onFailure: (cause) =>
        cause.reasons.some(Cause.isInterruptReason)
          ? Effect.failCause(cause)
          : Effect.flatMap(this.evaluateStatement(finalizer), (final) =>
              isAbrupt(final) ? Effect.succeed(final) : Effect.failCause(cause)),
      onSuccess: (result) =>
        Effect.flatMap(this.evaluateStatement(finalizer), (final) =>
          isAbrupt(final) ? Effect.succeed(final) : Effect.succeed(result)),
    })
  }

  private evaluateVariableDeclaration(node: AstNode): Effect.Effect<void, unknown, R> {
    const kind = getString(node, "kind")
    const declarations = getArray(node, "declarations")
    const self = this
    return Effect.gen(function*() {
      for (const declarationValue of declarations) {
        const declaration = asNode(declarationValue, "declarations")

        if (declaration.type !== "VariableDeclarator") {
          throw new InterpreterRuntimeError("Unsupported variable declaration shape.", declaration)
        }

        const init = getOptionalNode(declaration, "init")
        const value = init ? yield* self.evaluateExpression(init) : undefined
        self.declarePattern(getNode(declaration, "id"), value, kind !== "const", declaration)
      }
    })
  }

  private declarePattern(pattern: AstNode, value: unknown, mutable: boolean, node: AstNode): void {
    if (pattern.type === "Identifier") {
      this.declare(getString(pattern, "name"), value, mutable, node)
      return
    }

    if (pattern.type === "ObjectPattern") {
      if (value === null || typeof value !== "object" || Array.isArray(value) || isRuntimeReference(value)) {
        throw new InterpreterRuntimeError("Object destructuring requires a data object value.", pattern, "InvalidDataValue")
      }

      for (const propertyValue of getArray(pattern, "properties")) {
        const property = asNode(propertyValue, "properties")
        if (property.type !== "Property" || getBoolean(property, "computed") || getString(property, "kind") !== "init") {
          throw new InterpreterRuntimeError("Only named object destructuring properties are supported.", property)
        }

        const keyNode = getNode(property, "key")
        const key = keyNode.type === "Identifier" ? getString(keyNode, "name") : String(keyNode.value)
        if (isBlockedMember(key)) {
          throw new InterpreterRuntimeError(`Property '${key}' is not available in Rune.`, keyNode)
        }
        this.declarePattern(getNode(property, "value"), (value as SafeObject)[key], mutable, property)
      }
      return
    }

    if (pattern.type === "ArrayPattern") {
      if (!Array.isArray(value)) {
        throw new InterpreterRuntimeError("Array destructuring requires an array value.", pattern)
      }

      for (const [index, item] of getArray(pattern, "elements").entries()) {
        if (item !== null) {
          this.declarePattern(asNode(item, `elements[${index}]`), value[index], mutable, pattern)
        }
      }
      return
    }

    throw new InterpreterRuntimeError(`Unsupported binding pattern '${pattern.type}'.`, pattern)
  }

  private evaluateExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    this.recordOperation(node)

    switch (node.type) {
      case "Literal":
        return Effect.sync(() => boundedData(node.value, "Literal", node, this.limits))
      case "Identifier":
        return Effect.sync(() => this.getIdentifierValue(getString(node, "name"), node))
      case "BinaryExpression":
        return this.evaluateBinaryExpression(node)
      case "LogicalExpression":
        return this.evaluateLogicalExpression(node)
      case "UnaryExpression":
        return this.evaluateUnaryExpression(node)
      case "AssignmentExpression":
        return this.evaluateAssignmentExpression(node)
      case "CallExpression":
        return this.evaluateCallExpression(node)
      case "ArrowFunctionExpression":
        return Effect.sync(() => new RuneFunction(
          getArray(node, "params").map((parameter, index) => asNode(parameter, `params[${index}]`)),
          getNode(node, "body"),
          this.scopes.slice(),
        ))
      case "MemberExpression":
        return this.readMember(node)
      case "ChainExpression":
        return Effect.map(this.evaluateExpression(getNode(node, "expression")), (value) =>
          value === OptionalShortCircuit ? undefined : value)
      case "ObjectExpression":
        return this.evaluateObjectExpression(node)
      case "ArrayExpression":
        return this.evaluateArrayExpression(node)
      case "TemplateLiteral":
        return this.evaluateTemplateLiteral(node)
      case "ConditionalExpression":
        return this.evaluateConditionalExpression(node)
      case "UpdateExpression":
        return this.evaluateUpdateExpression(node)
      case "AwaitExpression": {
        return this.evaluateExpression(getNode(node, "argument"))
      }
      default:
        throw unsupportedSyntax(node.type, node)
    }
  }

  private evaluateBinaryExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    const operator = getString(node, "operator")
    const self = this
    return Effect.gen(function*() {
      const lhs = (yield* self.evaluateExpression(getNode(node, "left"))) as any
      const rhs = (yield* self.evaluateExpression(getNode(node, "right"))) as any
      if (containsRuntimeReference(lhs) || containsRuntimeReference(rhs)) {
        throw new InterpreterRuntimeError("Binary operators require data values in Rune.", node, "InvalidDataValue")
      }
      let result: unknown
      switch (operator) {
        case "+": result = lhs + rhs; break
        case "-": result = lhs - rhs; break
        case "*": result = lhs * rhs; break
        case "/": result = lhs / rhs; break
        case "%": result = lhs % rhs; break
        case "**": result = lhs ** rhs; break
        case "==": result = lhs == rhs; break
        case "===": result = lhs === rhs; break
        case "!=": result = lhs != rhs; break
        case "!==": result = lhs !== rhs; break
        case "<": result = lhs < rhs; break
        case "<=": result = lhs <= rhs; break
        case ">": result = lhs > rhs; break
        case ">=": result = lhs >= rhs; break
        default: throw new InterpreterRuntimeError(`Unsupported binary operator '${operator}'.`, node)
      }
      return boundedData(result, "Binary expression result", node, self.limits)
    })
  }

  private evaluateLogicalExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    const operator = getString(node, "operator")
    return Effect.flatMap(this.evaluateExpression(getNode(node, "left")), (left) => {
      if (operator === "&&") return left ? this.evaluateExpression(getNode(node, "right")) : Effect.succeed(left)
      if (operator === "||") return left ? Effect.succeed(left) : this.evaluateExpression(getNode(node, "right"))
      if (operator === "??") return left !== null && left !== undefined ? Effect.succeed(left) : this.evaluateExpression(getNode(node, "right"))
      throw new InterpreterRuntimeError(`Unsupported logical operator '${operator}'.`, node)
    })
  }

  private evaluateUnaryExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    const operator = getString(node, "operator")
    return Effect.map(this.evaluateExpression(getNode(node, "argument")), (value) => {
      if (containsRuntimeReference(value)) {
        throw new InterpreterRuntimeError("Unary operators require data values in Rune.", node, "InvalidDataValue")
      }
      const rhs = value as any
      let result: unknown
      switch (operator) {
        case "+": result = +rhs; break
        case "-": result = -rhs; break
        case "!": result = !rhs; break
        case "typeof": result = typeof rhs; break
        default: throw new InterpreterRuntimeError(`Unsupported unary operator '${operator}'.`, node)
      }
      return boundedData(result, "Unary expression result", node, this.limits)
    })
  }

  private evaluateAssignmentExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    const left = getNode(node, "left")
    const operator = getString(node, "operator")
    const self = this
    return Effect.gen(function*() {
      const rightValue = yield* self.evaluateExpression(getNode(node, "right"))
      if (left.type === "Identifier") {
        const name = getString(left, "name")
        if (operator === "=") return self.setIdentifierValue(name, rightValue, left)
        const next = boundedData(self.applyCompoundAssignment(operator, self.getIdentifierValue(name, left), rightValue, node), "Assignment result", node, self.limits)
        return self.setIdentifierValue(name, next, left)
      }
      if (left.type === "MemberExpression") {
        if (operator === "=") return yield* self.writeMember(left, rightValue)
        return yield* self.modifyMember(left, (current) => {
          const next = boundedData(self.applyCompoundAssignment(operator, current, rightValue, node), "Assignment result", node, self.limits)
          return { next, result: next }
        })
      }
      throw new InterpreterRuntimeError("Assignment target must be an Identifier or MemberExpression.", left)
    })
  }

  private evaluateUpdateExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    const operator = getString(node, "operator")
    const argument = getNode(node, "argument")
    const prefix = getBoolean(node, "prefix")

    const increment = operator === "++" ? 1 : operator === "--" ? -1 : undefined

    if (increment === undefined) {
      throw new InterpreterRuntimeError(`Unsupported update operator '${operator}'.`, node)
    }

    if (argument.type === "Identifier") {
      return Effect.sync(() => {
        const name = getString(argument, "name")
        const current = Number(this.getIdentifierValue(name, argument))
        const next = boundedData(current + increment, "Update result", node, this.limits) as number
        this.setIdentifierValue(name, next, argument)
        return prefix ? next : current
      })
    }

    if (argument.type === "MemberExpression") {
      return this.modifyMember(argument, (current) => {
        const value = Number(current)
        const next = boundedData(value + increment, "Update result", node, this.limits) as number
        return { next, result: prefix ? next : value }
      })
    }

    throw new InterpreterRuntimeError("Update target must be an Identifier or MemberExpression.", argument)
  }

  private evaluateCallExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    const callee = getNode(node, "callee")
    const argNodes = getArray(node, "arguments")

    const self = this
    return Effect.gen(function*() {
      const callable = yield* self.evaluateExpression(callee)
      if (callable === OptionalShortCircuit) return OptionalShortCircuit
      if ((callable === null || callable === undefined) && node.optional === true) return OptionalShortCircuit
      if (callable instanceof PromiseAllReference) {
        if (argNodes.length !== 1) {
          throw new InterpreterRuntimeError(`Promise.all expects exactly one collection expression. ${supportedSyntaxMessage}`, node)
        }
        const argument = asNode(argNodes[0], "arguments[0]")
        return yield* self.evaluatePromiseAll(argument, node)
      }

      const args = yield* self.evaluateCallArguments(argNodes)

      if (callable instanceof ToolReference) {
        if (callable.path.length === 0) throw new InterpreterRuntimeError("The tools root is not callable.", callee)
        return yield* self.invokeTool(callable.path, args)
      }
      if (callable instanceof RuneFunction) {
        return yield* self.invokeFunction(callable, args)
      }
      if (callable instanceof IntrinsicReference) {
        return yield* self.invokeIntrinsic(callable, args, node)
      }
      if (callable instanceof GlobalMethodReference) {
        return boundedData(invokeGlobalMethod(callable, args, node, self.limits), `${callable.namespace}.${callable.name} result`, node, self.limits)
      }
      if (callable instanceof CoercionFunction) {
        return boundedData(invokeCoercion(callable, args, node, self.limits), `${callable.name} result`, node, self.limits)
      }
      throw new InterpreterRuntimeError("Only tool capabilities are callable in Rune.", callee)
    })
  }

  private evaluateCallArguments(argNodes: Array<unknown>): Effect.Effect<Array<unknown>, unknown, R> {
    const self = this
    return Effect.gen(function*() {
      const args: Array<unknown> = []
      for (const [index, arg] of argNodes.entries()) {
        const argNode = asNode(arg, `arguments[${index}]`)
        if (argNode.type === "SpreadElement") {
          const spread = yield* self.evaluateExpression(getNode(argNode, "argument"))
          if (!Array.isArray(spread)) throw new InterpreterRuntimeError("Spread arguments require an array in Rune.", argNode)
          if (args.length + spread.length > self.limits.maxCollectionLength) {
            throw new InterpreterRuntimeError(`Call arguments exceed the maximum collection length of ${self.limits.maxCollectionLength}.`, argNode, "InvalidDataValue")
          }
          args.push(...spread)
        } else {
          args.push(yield* self.evaluateExpression(argNode))
          if (args.length > self.limits.maxCollectionLength) {
            throw new InterpreterRuntimeError(`Call arguments exceed the maximum collection length of ${self.limits.maxCollectionLength}.`, argNode, "InvalidDataValue")
          }
        }
      }
      return args
    })
  }

  private evaluatePromiseAll(argument: AstNode, node: AstNode): Effect.Effect<Array<unknown>, unknown, R> {
    if (argument.type === "ArrayExpression") {
      const elements = getArray(argument, "elements")
      if (elements.length > this.limits.maxCollectionLength) {
        throw new InterpreterRuntimeError(`Promise.all exceeds the maximum collection length of ${this.limits.maxCollectionLength}.`, node, "ConcurrencyLimitExceeded")
      }
      const calls = elements.map((value, index) => {
        if (value === null) {
          throw new InterpreterRuntimeError(`Promise.all array elements must be direct Tool Capability calls. ${supportedSyntaxMessage}`, argument)
        }
        const element = asNode(value, `elements[${index}]`)
        if (element.type === "SpreadElement") {
          throw new InterpreterRuntimeError(`Promise.all does not support spread elements yet. ${supportedSyntaxMessage}`, element)
        }
        if (!this.isToolCallExpression(element)) {
          throw new InterpreterRuntimeError(`Promise.all array elements must be direct Tool Capability calls. ${supportedSyntaxMessage}`, element)
        }
        return element.type === "AwaitExpression" ? getNode(element, "argument") : element
      })
      const self = this
      return Effect.gen(function*() {
        const prepared: Array<{ readonly path: ReadonlyArray<string>; readonly args: Array<unknown> }> = []
        for (const call of calls) {
          const callable = yield* self.evaluateExpression(getNode(call, "callee"))
          if (!(callable instanceof ToolReference) || callable.path.length === 0) {
            throw new InterpreterRuntimeError("Promise.all expects direct Tool Capability calls.", call)
          }
          const args = yield* self.evaluateCallArguments(getArray(call, "arguments"))
          prepared.push({ path: callable.path, args })
        }
        const values = yield* Effect.all(prepared.map(({ path, args }) => self.invokeTool(path, args)), { concurrency: self.limits.maxConcurrency })
        return boundedProgramValue(values, "Promise.all result", node, self.limits) as Array<unknown>
      })
    }

    if (argument.type === "CallExpression") {
      return this.evaluateParallelMap(argument, node)
    }

    throw new InterpreterRuntimeError(`Promise.all supports an array literal or a direct .map(...) expression. ${supportedSyntaxMessage}`, node)
  }

  private evaluateParallelMap(call: AstNode, node: AstNode): Effect.Effect<Array<unknown>, unknown, R> {
    const callee = getNode(call, "callee")
    const args = getArray(call, "arguments")
    if (callee.type !== "MemberExpression" || args.length !== 1) {
      throw new InterpreterRuntimeError(`Promise.all supports direct items.map((item) => tools.path(item)) expressions. ${supportedSyntaxMessage}`, node)
    }

    const self = this
    return Effect.gen(function*() {
      const method = yield* self.evaluateExpression(callee)
      const callback = yield* self.evaluateExpression(asNode(args[0], "arguments[0]"))
      if (!(method instanceof IntrinsicReference) || method.name !== "map" || !(callback instanceof RuneFunction)) {
        throw new InterpreterRuntimeError(`Promise.all supports direct items.map((item) => tools.path(item)) expressions. ${supportedSyntaxMessage}`, node)
      }
      if (!self.isToolCallExpression(callback.body)) {
        throw new InterpreterRuntimeError(`Promise.all mapped callbacks must directly call a Tool Capability. ${supportedSyntaxMessage}`, node)
      }
      const items = method.receiver as Array<unknown>
      if (items.length > self.limits.maxCollectionLength) {
        throw new InterpreterRuntimeError(`Promise.all exceeds the maximum collection length of ${self.limits.maxCollectionLength}.`, node, "ConcurrencyLimitExceeded")
      }

      const values = yield* Effect.all(
        items.map((item, index) => Effect.suspend(() => self.forkForParallelCallback().invokeFunction(callback, [item, index]))),
        { concurrency: self.limits.maxConcurrency },
      )
      return boundedProgramValue(values, "Promise.all result", node, self.limits) as Array<unknown>
    })
  }

  private isToolCallExpression(node: AstNode): boolean {
    const expression = node.type === "AwaitExpression" ? getNode(node, "argument") : node
    return expression.type === "CallExpression" && this.isToolPath(getNode(expression, "callee"))
  }

  private isToolPath(node: AstNode): boolean {
    if (node.type === "Identifier") return getString(node, "name") === "tools"
    return node.type === "MemberExpression" && this.isToolPath(getNode(node, "object"))
  }

  private invokeFunction(fn: RuneFunction, args: Array<unknown>): Effect.Effect<unknown, unknown, R> {
    const self = this
    return Effect.suspend(() => {
      const savedScopes = self.scopes
      self.scopes = [...fn.capturedScopes, new Map<string, Binding>()]
      const run = Effect.gen(function*() {
        for (const [index, parameter] of fn.parameters.entries()) {
          self.declarePattern(parameter, args[index], true, parameter)
        }

        if (fn.body.type === "BlockStatement") {
          const result = yield* self.evaluateStatement(fn.body)
          return result.kind === "return" || result.kind === "value" ? result.value : undefined
        }

        return yield* self.evaluateExpression(fn.body)
      })
      return run.pipe(Effect.ensuring(Effect.sync(() => { self.scopes = savedScopes })))
    })
  }

  private invokeIntrinsic(ref: IntrinsicReference, args: Array<unknown>, node: AstNode): Effect.Effect<unknown, unknown, R> {
    if (typeof ref.receiver === "string") {
      return Effect.succeed(invokeStringMethod(ref.receiver, ref.name, args, node, this.limits))
    }
    if (Array.isArray(ref.receiver)) {
      return this.invokeArrayMethod(ref.receiver, ref.name, args, node)
    }
    throw new InterpreterRuntimeError(`Method '${ref.name}' is not available in Rune.`, node)
  }

  private invokeArrayMethod(target: Array<unknown>, name: string, args: Array<unknown>, node: AstNode): Effect.Effect<unknown, unknown, R> {
    const boundedCollection = (items: Array<unknown>): Array<unknown> => {
      if (items.length > this.limits.maxCollectionLength) {
        throw new InterpreterRuntimeError(`Array.${name} exceeds the maximum collection length of ${this.limits.maxCollectionLength}.`, node, "InvalidDataValue")
      }
      return boundedProgramValue(items, `Array.${name} result`, node, this.limits) as Array<unknown>
    }
    const optNumber = (value: unknown, label: string): number | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== "number") throw new InterpreterRuntimeError(`Array.${name} expects ${label} to be a number.`, node)
      return value
    }
    switch (name) {
      case "join": {
        if (args.length > 1 || (args.length === 1 && typeof args[0] !== "string")) {
          throw new InterpreterRuntimeError("Array.join expects zero arguments or one string separator.", node)
        }
        const input = boundedData(target, "Array.join input", node, this.limits) as Array<unknown>
        return Effect.succeed(boundedData(input.map((item) => coerceToString(item ?? "")).join(args.length === 0 ? "," : args[0] as string), "Array.join result", node, this.limits))
      }
      case "includes":
        if (args.length === 0 || args.length > 2) throw new InterpreterRuntimeError("Array.includes expects a value and optional start index.", node)
        return Effect.succeed(target.includes(args[0], optNumber(args[1], "start index")))
      case "indexOf":
        return Effect.succeed(target.indexOf(args[0], optNumber(args[1], "start index")))
      case "lastIndexOf":
        return Effect.succeed(args[1] === undefined ? target.lastIndexOf(args[0]) : target.lastIndexOf(args[0], optNumber(args[1], "start index")))
      case "at":
        return Effect.succeed(target.at(optNumber(args[0], "index") ?? 0))
      case "slice":
        return Effect.succeed(boundedCollection(target.slice(optNumber(args[0], "start"), optNumber(args[1], "end"))))
      case "concat":
        return Effect.succeed(boundedCollection(target.concat(...args)))
      case "flat":
        return Effect.succeed(boundedCollection(target.flat(optNumber(args[0], "depth") ?? 1)))
      case "reverse":
        return Effect.succeed(boundedCollection([...target].reverse()))
      case "sort":
        return this.sortArray(target, args[0], node)
    }

    const callback = args[0]
    if (!(callback instanceof RuneFunction)) {
      throw new InterpreterRuntimeError(`Array.${name} expects an arrow function callback.`, node)
    }
    const self = this
    return Effect.gen(function*() {
      switch (name) {
        case "map": {
          const values: Array<unknown> = []
          for (const [index, item] of target.entries()) values.push(yield* self.invokeFunction(callback, [item, index]))
          return boundedCollection(values)
        }
        case "flatMap": {
          const values: Array<unknown> = []
          for (const [index, item] of target.entries()) {
            const mapped = yield* self.invokeFunction(callback, [item, index])
            if (Array.isArray(mapped)) values.push(...mapped)
            else values.push(mapped)
            boundedCollection(values)
          }
          return boundedCollection(values)
        }
        case "filter": {
          const values: Array<unknown> = []
          for (const [index, item] of target.entries()) {
            if (yield* self.invokeFunction(callback, [item, index])) values.push(item)
          }
          return boundedCollection(values)
        }
        case "find":
          for (const [index, item] of target.entries()) {
            if (yield* self.invokeFunction(callback, [item, index])) return item
          }
          return undefined
        case "findIndex":
          for (const [index, item] of target.entries()) {
            if (yield* self.invokeFunction(callback, [item, index])) return index
          }
          return -1
        case "some":
          for (const [index, item] of target.entries()) {
            if (yield* self.invokeFunction(callback, [item, index])) return true
          }
          return false
        case "every":
          for (const [index, item] of target.entries()) {
            if (!(yield* self.invokeFunction(callback, [item, index]))) return false
          }
          return true
        case "forEach":
          for (const [index, item] of target.entries()) yield* self.invokeFunction(callback, [item, index])
          return undefined
        case "reduce": {
          let accumulator: unknown
          let start: number
          if (args.length >= 2) {
            accumulator = args[1]
            start = 0
          } else {
            if (target.length === 0) throw new InterpreterRuntimeError("Array.reduce of an empty array with no initial value.", node)
            accumulator = target[0]
            start = 1
          }
          for (let index = start; index < target.length; index += 1) {
            accumulator = yield* self.invokeFunction(callback, [accumulator, target[index], index])
          }
          return accumulator
        }
      }
      throw new InterpreterRuntimeError(`Array method '${name}' is not available in Rune.`, node)
    })
  }

  private sortArray(target: Array<unknown>, comparator: unknown, node: AstNode): Effect.Effect<Array<unknown>, unknown, R> {
    if (comparator !== undefined && !(comparator instanceof RuneFunction)) {
      throw new InterpreterRuntimeError("Array.sort expects an arrow function comparator.", node)
    }
    if (!(comparator instanceof RuneFunction)) {
      return Effect.sync(() => boundedProgramValue(
        [...target].sort((a, b) => {
          const left = coerceToString(a)
          const right = coerceToString(b)
          return left < right ? -1 : left > right ? 1 : 0
        }),
        "Array.sort result",
        node,
        this.limits,
      ) as Array<unknown>)
    }
    const self = this
    const mergeSort = (items: Array<unknown>): Effect.Effect<Array<unknown>, unknown, R> => {
      if (items.length <= 1) return Effect.succeed(items)
      const midpoint = Math.floor(items.length / 2)
      return Effect.gen(function*() {
        const left = yield* mergeSort(items.slice(0, midpoint))
        const right = yield* mergeSort(items.slice(midpoint))
        const merged: Array<unknown> = []
        let leftIndex = 0
        let rightIndex = 0
        while (leftIndex < left.length && rightIndex < right.length) {
          const order = Number(yield* self.invokeFunction(comparator, [left[leftIndex], right[rightIndex]]))
          if (order <= 0) merged.push(left[leftIndex++])
          else merged.push(right[rightIndex++])
        }
        return [...merged, ...left.slice(leftIndex), ...right.slice(rightIndex)]
      })
    }
    return Effect.map(mergeSort([...target]), (items) =>
      boundedProgramValue(items, "Array.sort result", node, this.limits) as Array<unknown>)
  }

  private evaluateObjectExpression(node: AstNode): Effect.Effect<Record<string, unknown>, unknown, R> {
    const objectValue: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const keys = new Set<string>()
    const properties = getArray(node, "properties")
    const self = this
    return Effect.gen(function*() {
      for (const propertyValue of properties) {
        const property = asNode(propertyValue, "properties")

        if (property.type === "SpreadElement") {
          const spread = yield* self.evaluateExpression(getNode(property, "argument"))
          if (spread === null || typeof spread !== "object" || Array.isArray(spread) || isRuntimeReference(spread)) {
            throw new InterpreterRuntimeError("Object spread requires a data object in Rune.", property, "InvalidDataValue")
          }
          for (const [key, value] of Object.entries(spread)) {
            if (isBlockedMember(key)) throw new InterpreterRuntimeError(`Property '${key}' is not available in Rune.`, property)
            objectValue[key] = value
            keys.add(key)
            if (keys.size > self.limits.maxCollectionLength) {
              throw new InterpreterRuntimeError(`Object expression exceeds the maximum collection length of ${self.limits.maxCollectionLength}.`, property, "InvalidDataValue")
            }
          }
          continue
        }

        if (property.type !== "Property") {
          throw new InterpreterRuntimeError("Only standard object properties are supported.", property)
        }

        if (getString(property, "kind") !== "init") {
          throw new InterpreterRuntimeError("Only init object properties are supported.", property)
        }

        const keyNode = getNode(property, "key")
        const valueNode = getNode(property, "value")
        const computed = getBoolean(property, "computed")

        let key: PropertyKey

        if (computed) {
          key = self.toPropertyKey(yield* self.evaluateExpression(keyNode), keyNode)
        } else if (keyNode.type === "Identifier") {
          key = getString(keyNode, "name")
        } else if (keyNode.type === "Literal") {
          key = self.toPropertyKey(keyNode.value, keyNode)
        } else {
          throw new InterpreterRuntimeError("Unsupported object property key shape.", keyNode)
        }

        if (isBlockedMember(String(key))) {
          throw new InterpreterRuntimeError(`Property '${String(key)}' is not available in Rune.`, keyNode)
        }
        objectValue[String(key)] = yield* self.evaluateExpression(valueNode)
        keys.add(String(key))
        if (keys.size > self.limits.maxCollectionLength) {
          throw new InterpreterRuntimeError(`Object expression exceeds the maximum collection length of ${self.limits.maxCollectionLength}.`, property, "InvalidDataValue")
        }
      }

      return boundedProgramValue(objectValue, "Object expression result", node, self.limits) as Record<string, unknown>
    })
  }

  private evaluateArrayExpression(node: AstNode): Effect.Effect<Array<unknown>, unknown, R> {
    const elements = getArray(node, "elements")
    const values: Array<unknown> = []

    const self = this
    return Effect.gen(function*() {
      for (const elementValue of elements) {
        if (elementValue === null) {
          values.push(undefined)
          if (values.length > self.limits.maxCollectionLength) {
            throw new InterpreterRuntimeError(`Array expression exceeds the maximum collection length of ${self.limits.maxCollectionLength}.`, node, "InvalidDataValue")
          }
          continue
        }
        const element = asNode(elementValue, "elements")
        if (element.type === "SpreadElement") {
          const spread = yield* self.evaluateExpression(getNode(element, "argument"))
          if (!Array.isArray(spread)) throw new InterpreterRuntimeError("Array spread requires an array in Rune.", element)
          values.push(...spread)
        } else {
          values.push(yield* self.evaluateExpression(element))
        }
        if (values.length > self.limits.maxCollectionLength) {
          throw new InterpreterRuntimeError(`Array expression exceeds the maximum collection length of ${self.limits.maxCollectionLength}.`, node, "InvalidDataValue")
        }
      }
      return boundedProgramValue(values, "Array expression result", node, self.limits) as Array<unknown>
    })
  }

  private evaluateTemplateLiteral(node: AstNode): Effect.Effect<string, unknown, R> {
    const quasis = getArray(node, "quasis")
    const expressions = getArray(node, "expressions")

    let output = ""

    const self = this
    return Effect.gen(function*() {
      for (let index = 0; index < quasis.length; index += 1) {
        const quasi = asNode(quasis[index], "quasis")
        const rawValue = quasi.value

        if (!isRecord(rawValue) || typeof rawValue.cooked !== "string") {
          throw new InterpreterRuntimeError("Invalid template literal quasi.", quasi)
        }

        output += rawValue.cooked
        boundedData(output, "Template literal result", node, self.limits)

        if (index < expressions.length) {
          const value = boundedData(yield* self.evaluateExpression(asNode(expressions[index], "expressions")), "Template interpolation", node, self.limits)
          output += coerceToString(value)
          boundedData(output, "Template literal result", node, self.limits)
        }
      }

      return output
    })
  }

  private evaluateConditionalExpression(node: AstNode): Effect.Effect<unknown, unknown, R> {
    return Effect.flatMap(this.evaluateExpression(getNode(node, "test")), (test) =>
      this.evaluateExpression(getNode(node, test ? "consequent" : "alternate")))
  }

  private applyCompoundAssignment(
    operator: string,
    current: unknown,
    incoming: unknown,
    node: AstNode,
  ): unknown {
    const lhs = current as any
    const rhs = incoming as any

    switch (operator) {
      case "+=":
        return lhs + rhs
      case "-=":
        return lhs - rhs
      case "*=":
        return lhs * rhs
      case "/=":
        return lhs / rhs
      case "%=":
        return lhs % rhs
      case "**=":
        return lhs ** rhs
      default:
        throw new InterpreterRuntimeError(`Unsupported assignment operator '${operator}'.`, node)
    }
  }

  private getMemberReference(node: AstNode): Effect.Effect<MemberReference | ToolReference | PromiseAllReference | IntrinsicReference | GlobalMethodReference | ComputedValue | typeof OptionalShortCircuit | undefined, unknown, R> {
    const objectNode = getNode(node, "object")
    const propertyNode = getNode(node, "property")
    const computed = getBoolean(node, "computed")
    const optional = node.optional === true
    const self = this
    return Effect.gen(function*() {
      const objectValue = yield* self.evaluateExpression(objectNode)
      if (objectValue === OptionalShortCircuit) return OptionalShortCircuit
      if ((objectValue === null || objectValue === undefined) && optional) return OptionalShortCircuit

      const key = computed
        ? self.toPropertyKey(yield* self.evaluateExpression(propertyNode), propertyNode)
        : propertyNode.type === "Identifier"
          ? getString(propertyNode, "name")
          : self.toPropertyKey(yield* self.evaluateExpression(propertyNode), propertyNode)

      if (objectValue instanceof ToolReference) {
        if (typeof key !== "string" || isBlockedMember(key)) {
          throw new InterpreterRuntimeError("Tool paths must use safe string property names.", propertyNode)
        }
        return new ToolReference([...objectValue.path, key])
      }

      if (objectValue instanceof PromiseNamespace) {
        if (key === "all") return new PromiseAllReference()
        throw new InterpreterRuntimeError(`Promise.${String(key)} is not available in Rune. Use Promise.all(...) for parallel Tool Capabilities.`, propertyNode)
      }

      if (objectValue instanceof GlobalNamespace) {
        if (typeof key !== "string" || isBlockedMember(key)) {
          throw new InterpreterRuntimeError(`${objectValue.name}.${String(key)} is not available in Rune.`, propertyNode)
        }
        if (objectValue.name === "Math" && mathConstants.has(key)) {
          return new ComputedValue((Math as unknown as Record<string, number>)[key])
        }
        return new GlobalMethodReference(objectValue.name, key)
      }

      if (typeof objectValue === "string") {
        if (key === "length") return new ComputedValue(objectValue.length)
        if (typeof key === "number") return new ComputedValue(objectValue[key])
        if (typeof key === "string" && /^\d+$/.test(key)) return new ComputedValue(objectValue[Number(key)])
        if (typeof key === "string" && stringMethods.has(key)) return new IntrinsicReference(objectValue, key)
        throw new InterpreterRuntimeError(`String property '${String(key)}' is not available in Rune.`, propertyNode)
      }

      if (isRuntimeReference(objectValue)) {
        throw new InterpreterRuntimeError("Rune runtime references are opaque and do not expose properties.", objectNode, "InvalidDataValue")
      }

      if (typeof objectValue !== "object" || objectValue === null) {
        throw new InterpreterRuntimeError("Cannot access a property on a non-object value.", objectNode)
      }

      if (typeof key === "string" && isBlockedMember(key)) {
        throw new InterpreterRuntimeError(`Property '${key}' is not available in Rune.`, propertyNode)
      }

      if (Array.isArray(objectValue)) {
        if (key !== "length" && !(typeof key === "string" && arrayMethods.has(key)) && (typeof key !== "number" && !/^\d+$/.test(key))) {
          if (typeof key === "string" && retryableArrayMethods.has(key)) {
            throw new InterpreterRuntimeError(
              `Array.${key}(...) is not supported in Rune. Rewrite using map/filter/find/some/every/includes/join or a for...of loop.`,
              propertyNode,
              "UnsupportedSyntax",
              [supportedSyntaxMessage],
            )
          }
          throw new InterpreterRuntimeError(`Array property '${String(key)}' is not available in Rune.`, propertyNode)
        }
        return { target: objectValue, key }
      }

      return { target: objectValue as SafeObject, key }
    })
  }

  private readMember(node: AstNode): Effect.Effect<unknown, unknown, R> {
    return Effect.map(this.getMemberReference(node), (reference) => {
      if (reference === OptionalShortCircuit) return OptionalShortCircuit
      if (reference instanceof ComputedValue) return reference.value
      if (
        reference === undefined ||
        reference instanceof ToolReference ||
        reference instanceof PromiseAllReference ||
        reference instanceof IntrinsicReference ||
        reference instanceof GlobalMethodReference
      ) return reference
      if (Array.isArray(reference.target)) {
        if (typeof reference.key === "string" && arrayMethods.has(reference.key)) {
          return new IntrinsicReference(reference.target, reference.key)
        }
        return reference.key === "length" ? reference.target.length : reference.target[Number(reference.key)]
      }
      return reference.target[String(reference.key)]
    })
  }

  private writeMember(node: AstNode, value: unknown): Effect.Effect<unknown, unknown, R> {
    return this.modifyMember(node, () => ({ next: value, result: value }))
  }

  private modifyMember(
    node: AstNode,
    compute: (current: unknown) => { next: unknown; result: unknown },
  ): Effect.Effect<unknown, unknown, R> {
    return Effect.map(this.getMemberReference(node), (reference) => {
      if (
        reference === OptionalShortCircuit ||
        reference instanceof ComputedValue ||
        reference === undefined ||
        reference instanceof ToolReference ||
        reference instanceof PromiseAllReference ||
        reference instanceof IntrinsicReference ||
        reference instanceof GlobalMethodReference
      ) {
        throw new InterpreterRuntimeError("Only data fields may be assigned in Rune.", node)
      }
      if (Array.isArray(reference.target)) {
        if (reference.key === "length") throw new InterpreterRuntimeError("Array length cannot be assigned in Rune.", node)
        if (typeof reference.key === "string" && arrayMethods.has(reference.key)) {
          throw new InterpreterRuntimeError("Array methods cannot be assigned in Rune.", node)
        }
        const index = Number(reference.key)
        if (!Number.isInteger(index) || index < 0 || index >= this.limits.maxCollectionLength) {
          throw new InterpreterRuntimeError(`Array assignment index must be between 0 and ${this.limits.maxCollectionLength - 1}.`, node, "InvalidDataValue")
        }
        const { next, result } = compute(reference.target[index])
        const previous = reference.target[index]
        const existed = Object.hasOwn(reference.target, index)
        const previousLength = reference.target.length
        reference.target[index] = next
        try {
          boundedProgramValue(reference.target, "Array assignment result", node, this.limits)
        } catch (error) {
          if (existed) reference.target[index] = previous
          else {
            delete reference.target[index]
            reference.target.length = previousLength
          }
          throw error
        }
        return result
      }
      const key = String(reference.key)
      if (!Object.hasOwn(reference.target, key) && Object.keys(reference.target).length >= this.limits.maxCollectionLength) {
        throw new InterpreterRuntimeError(`Object assignment exceeds the maximum collection length of ${this.limits.maxCollectionLength}.`, node, "InvalidDataValue")
      }
      const { next, result } = compute(reference.target[key])
      const previous = reference.target[key]
      const existed = Object.hasOwn(reference.target, key)
      reference.target[key] = next
      try {
        boundedProgramValue(reference.target, "Object assignment result", node, this.limits)
      } catch (error) {
        if (existed) reference.target[key] = previous
        else delete reference.target[key]
        throw error
      }
      return result
    })
  }

  private toPropertyKey(value: unknown, node: AstNode): string | number {
    if (typeof value === "string" || typeof value === "number") {
      return value
    }

    throw new InterpreterRuntimeError("Property key must be a string or number.", node)
  }

  private declare(name: string, value: unknown, mutable: boolean, node: AstNode): void {
    const scope = this.currentScope()

    if (scope.has(name)) {
      throw new InterpreterRuntimeError(`Identifier '${name}' has already been declared.`, node)
    }

    scope.set(name, { mutable, value })
  }

  private getIdentifierValue(name: string, node: AstNode): unknown {
    const binding = this.resolveBinding(name)

    if (!binding) {
      throw new InterpreterRuntimeError(`Unknown identifier '${name}'.`, node)
    }

    return binding.value
  }

  private setIdentifierValue(name: string, value: unknown, node: AstNode): unknown {
    const binding = this.resolveBinding(name)

    if (!binding) {
      throw new InterpreterRuntimeError(`Unknown identifier '${name}'.`, node)
    }

    if (!binding.mutable) {
      throw new InterpreterRuntimeError(`Cannot assign to constant '${name}'.`, node)
    }

    binding.value = value
    return value
  }

  private resolveBinding(name: string): Binding | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.scopes[index]
      const binding = scope?.get(name)

      if (binding) {
        return binding
      }
    }

    return undefined
  }

  private currentScope(): Map<string, Binding> {
    const scope = this.scopes[this.scopes.length - 1]

    if (!scope) {
      throw new InterpreterRuntimeError("Interpreter scope stack is empty.")
    }

    return scope
  }

  private pushScope(): void {
    this.scopes.push(new Map())
  }

  private popScope(): void {
    this.scopes.pop()
  }

  private forkForParallelCallback(): Interpreter<R> {
    const fork = new Interpreter(this.limits, this.invokeTool, this.budget)
    fork.scopes.splice(
      0,
      fork.scopes.length,
      ...this.scopes.map((scope) => new Map(Array.from(scope, ([name, binding]) => [name, { ...binding }]))),
    )
    return fork
  }

  private recordOperation(node: AstNode): void {
    this.budget.operations += 1

    if (this.budget.operations > this.limits.maxOperations) {
      throw new InterpreterRuntimeError(`Execution exceeded its operation limit of ${this.limits.maxOperations}.`, node, "OperationLimitExceeded")
    }
  }
}

export const execute = <const Tools extends Record<string, unknown>, RA = never>(options: ExecuteOptions<Tools, RA>): Effect.Effect<ExecuteResult, never, Services<Tools> | RA> => {
  const limits = resolveExecutionLimits(options.limits)
  const tools = ToolRuntime.make((options.tools ?? {}) as HostTools<Services<Tools>>, limits.maxToolCalls, limits, {
    ...(options.policy ? { policy: options.policy as Policy.RuntimeConfig } : {}),
    ...(options.requestApproval ? { requestApproval: options.requestApproval as RequestApproval<string, RA> } : {}),
  })

  if (new TextEncoder().encode(options.code).byteLength > limits.maxSourceBytes) {
    return Effect.succeed({
      ok: false,
      error: { kind: "InvalidDataValue", message: `Code exceeds the maximum source size of ${limits.maxSourceBytes} bytes.` },
      toolCalls: tools.calls,
    })
  }

  if (options.code.trim().length === 0) {
    return Effect.succeed({
      ok: false,
      error: { kind: "ParseError", message: "Code cannot be empty." },
      toolCalls: tools.calls,
    })
  }

  const operation = Effect.gen(function*() {
    const program = parseProgram(options.code)
    const interpreter = new Interpreter<Services<Tools> | RA>(limits, tools.invoke)
    const value = yield* interpreter.run(program)
    const copied = copyIn(value, "Execution result", limits)
    if (dataByteLength(copied) > limits.maxDataBytes) {
      throw new InterpreterRuntimeError(`Execution result exceeds the maximum data size of ${limits.maxDataBytes} bytes.`, undefined, "InvalidDataValue")
    }
    return {
      ok: true,
      value: copyOut(copied),
      toolCalls: tools.calls,
    } satisfies ExecuteResult
  }).pipe(
    Effect.timeoutOrElse({
      duration: limits.timeoutMs,
      orElse: () => Effect.succeed({
        ok: false,
        error: { kind: "TimeoutExceeded", message: `Execution timed out after ${limits.timeoutMs}ms.` },
        toolCalls: tools.calls,
      } satisfies ExecuteResult),
    }),
  )

  return operation.pipe(
    Effect.matchCause({
      onFailure: (cause): ExecuteResult => ({
        ok: false,
        error: normalizeError(Cause.squash(cause)),
        toolCalls: tools.calls,
      }),
      onSuccess: (result): ExecuteResult => result,
    }),
  )
}

export const make = <const Tools extends Record<string, unknown> = {}, RA = never>(options: RuneOptions<Tools, RA> = {} as RuneOptions<Tools, RA>): Rune<Services<Tools> | RA> => {
  const run = (code: string) => execute({ ...options, code })

  return {
    catalog: () => ToolRuntime.catalog((options.tools ?? {}) as HostTools<Services<Tools>>, options.policy as Policy.RuntimeConfig | undefined),
    instructions: () => ToolRuntime.instructions((options.tools ?? {}) as HostTools<Services<Tools>>, options.policy as Policy.RuntimeConfig | undefined),
    tool: () => ({
      name: "code",
      description: ToolRuntime.instructions((options.tools ?? {}) as HostTools<Services<Tools>>, options.policy as Policy.RuntimeConfig | undefined),
      input: CodeInput,
      execute: ({ code }) => run(code),
    }),
    run,
  }
}

export * as Rune from "./rune.ts"
