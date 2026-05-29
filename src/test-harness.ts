/**
 * Test harness for Rune.
 *
 * Rune evaluates an untrusted, TypeScript-shaped language and always resolves to a
 * structured {@link ExecuteResult} — it never throws. These helpers give every suite
 * one small, total vocabulary for driving the interpreter and asserting on results,
 * plus fast-check generators for property testing.
 *
 * Two doors into the runtime:
 *  - `run`        — the Promise-facing adapter (host tools are plain fns / async fns)
 *  - `runEffect`  — the Effect-native runtime (host tools return Effects; described tools)
 *
 * The property generators encode Rune's *contract*, not its implementation:
 *  - `Arb.dataValue`  — any value permitted to cross the tool boundary
 *  - `Arb.expression` — a pure program fragment whose meaning is identical in JavaScript,
 *                       enabling differential testing via {@link expectMatchesJs}.
 */
import { expect } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { Rune, type DiagnosticKind, type ExecuteResult, type ExecutionLimits } from "./rune.ts"
import { Rune as PromiseRune } from "./promise.ts"
import type { HostTools } from "./tool-runtime.ts"

// ── Driving the runtime ──────────────────────────────────────────────────────

type TestTools = { readonly [name: string]: ((...args: Array<unknown>) => unknown | PromiseLike<unknown>) | TestTools }

export type RunOptions = { readonly tools?: TestTools; readonly limits?: ExecutionLimits }

/** Execute a program through the Promise-facing runtime. */
export const run = (code: string, options: RunOptions = {}): Promise<ExecuteResult> =>
  PromiseRune.execute({ code, ...options } as never)

/** Execute a program through the Effect-native runtime (Effect tools, described tools). */
export const runEffect = (
  code: string,
  options: { readonly tools?: HostTools; readonly limits?: ExecutionLimits } = {},
): Promise<ExecuteResult> => {
  const program = Rune.make(options as never).run(code) as Effect.Effect<ExecuteResult, never, never>
  return Effect.runPromise(program)
}

export type Ok = Extract<ExecuteResult, { ok: true }>
export type Failure = Extract<ExecuteResult, { ok: false }>

// ── Assertions ───────────────────────────────────────────────────────────────

/** Assert success and return the narrowed result (with a useful message on failure). */
export const expectOk = (result: ExecuteResult): Ok => {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`)
  }
  return result
}

/** Run `code` and assert it succeeds with a value deep-equal to `expected`. */
export const expectValue = async (code: string, expected: unknown, options?: RunOptions): Promise<Ok> => {
  const result = expectOk(await run(code, options))
  expect(result.value).toEqual(expected)
  return result
}

export type FailureExpectation = {
  readonly kind?: DiagnosticKind
  readonly message?: string | RegExp
}

/** Run `code` and assert it fails, optionally matching a diagnostic kind and/or message. */
export const expectFailure = async (
  code: string,
  expectation: FailureExpectation = {},
  options?: RunOptions,
): Promise<Failure> => {
  const result = await run(code, options)
  if (result.ok) {
    throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  }
  if (expectation.kind !== undefined) expect(result.error.kind).toBe(expectation.kind)
  if (expectation.message instanceof RegExp) expect(result.error.message).toMatch(expectation.message)
  else if (typeof expectation.message === "string") expect(result.error.message).toContain(expectation.message)
  return result
}

// ── Tool spies ───────────────────────────────────────────────────────────────

export type Spy<A extends ReadonlyArray<unknown>, T> = ((...args: A) => T) & {
  readonly calls: ReadonlyArray<A>
  readonly count: number
}

/**
 * A host tool that records every invocation. Use it to assert *how many times* and
 * *with what arguments* a capability was reached — e.g. that compound assignment
 * evaluates its target exactly once.
 */
export const spy = <A extends ReadonlyArray<unknown>, T>(
  impl: (...args: A) => T = () => undefined as T,
): Spy<A, T> => {
  const calls: A[] = []
  const fn = ((...args: A) => {
    calls.push(args)
    return impl(...args)
  }) as Spy<A, T>
  Object.defineProperty(fn, "calls", { get: () => calls })
  Object.defineProperty(fn, "count", { get: () => calls.length })
  return fn
}

// ── Diagnostic vocabulary ────────────────────────────────────────────────────

export const DIAGNOSTIC_KINDS: ReadonlySet<DiagnosticKind> = new Set<DiagnosticKind>([
  "ParseError",
  "UnsupportedSyntax",
  "UnknownCapability",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "OperationLimitExceeded",
  "ToolCallLimitExceeded",
  "AuditLimitExceeded",
  "ConcurrencyLimitExceeded",
  "TimeoutExceeded",
  "CapabilityDenied",
  "ApprovalDenied",
  "ExecutionFailure",
])

/** The public Diagnostic contract: a known kind, a message, and never a host stack. */
export const isWellFormedResult = (result: ExecuteResult): boolean => {
  if (typeof result !== "object" || result === null || typeof result.ok !== "boolean") return false
  if (!Array.isArray(result.toolCalls)) return false
  if (result.ok) return true
  if (!DIAGNOSTIC_KINDS.has(result.error.kind)) return false
  if (typeof result.error.message !== "string") return false
  if ("stack" in result.error) return false
  return true
}

// ── Generators ───────────────────────────────────────────────────────────────

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"])

const dataKey = fc.string({ maxLength: 8 }).filter((key) => !BLOCKED_KEYS.has(key))

const finiteDouble = fc
  .double({ min: -1e9, max: 1e9, noNaN: true })
  .map((n) => (Object.is(n, -0) ? 0 : n))

/**
 * Any value permitted to cross the Rune <-> tool boundary: null, finite numbers,
 * booleans, strings, arrays of Data Values, and plain objects of Data Values with
 * non-blocked keys. Bounded in depth and breadth to stay within the default limits.
 */
const dataValue: fc.Arbitrary<unknown> = fc.letrec<{ data: unknown }>((tie) => ({
  data: fc.oneof(
    { maxDepth: 4 },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    finiteDouble,
    fc.string(),
    fc.array(tie("data"), { maxLength: 5 }),
    fc.dictionary(dataKey, tie("data"), { maxKeys: 5 }),
  ),
})).data

/**
 * A grammar of pure expressions whose evaluation is identical in Rune and in
 * JavaScript. Deliberately excludes everything where the two intentionally diverge
 * (object stringification, division/modulo → NaN/Infinity, out-of-range indexing).
 * Type-stratified so operands never coerce across types.
 */
const grammar = fc.letrec<{ num: string; bool: string; arr: string; str: string }>((tie) => ({
  num: fc.oneof(
    { maxDepth: 5, depthIdentifier: "expr" },
    fc.integer({ min: -1000, max: 1000 }).map(String),
    fc.tuple(tie("num"), fc.constantFrom("+", "-", "*"), tie("num")).map(([a, op, b]) => `(${a} ${op} ${b})`),
    fc.tuple(tie("bool"), tie("num"), tie("num")).map(([c, t, e]) => `(${c} ? ${t} : ${e})`),
    tie("arr").map((a) => `${a}.length`),
  ),
  bool: fc.oneof(
    { maxDepth: 5, depthIdentifier: "expr" },
    fc.boolean().map(String),
    fc.tuple(tie("num"), fc.constantFrom("===", "!==", "<", "<=", ">", ">="), tie("num")).map(([a, op, b]) => `(${a} ${op} ${b})`),
    fc.tuple(tie("bool"), fc.constantFrom("&&", "||"), tie("bool")).map(([a, op, b]) => `(${a} ${op} ${b})`),
    fc.tuple(tie("arr"), tie("num")).map(([a, n]) => `${a}.includes((${n}))`),
    fc.tuple(tie("arr"), tie("num")).map(([a, n]) => `${a}.some((x) => (x > (${n})))`),
    fc.tuple(tie("arr"), tie("num")).map(([a, n]) => `${a}.every((x) => (x >= (${n})))`),
  ),
  arr: fc.oneof(
    { maxDepth: 5, depthIdentifier: "expr" },
    fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 5 }).map((xs) => `[${xs.join(", ")}]`),
    fc.tuple(tie("arr"), tie("num")).map(([a, n]) => `${a}.map((x) => (x + (${n})))`),
    fc.tuple(tie("arr"), tie("num")).map(([a, n]) => `${a}.filter((x) => (x < (${n})))`),
  ),
  str: fc.oneof(
    { maxDepth: 5, depthIdentifier: "expr" },
    fc.string({ maxLength: 6 }).map((s) => JSON.stringify(s)),
    fc.tuple(tie("str"), tie("str")).map(([a, b]) => `(${a} + ${b})`),
    fc.tuple(tie("str"), tie("num")).map(([a, b]) => `(${a} + ${b})`),
  ),
}))

export const Arb = {
  dataValue,
  /** A pure expression source string that means the same thing in Rune and JavaScript. */
  expression: fc.oneof(grammar.num, grammar.bool, grammar.arr, grammar.str),
}

/** The JavaScript reference semantics for a pure expression source. */
export const referenceEval = (source: string): unknown =>
  // biome-ignore lint: differential oracle — evaluates trusted, generated pure expressions
  new Function(`"use strict"; return (${source})`)()

/** Assert Rune evaluates `source` to exactly the value JavaScript would. */
export const expectMatchesJs = async (source: string): Promise<void> => {
  const expected = referenceEval(source)
  const result = await run(`return (${source})`)
  expect(expectOk(result).value).toEqual(expected)
}

export { fc }
