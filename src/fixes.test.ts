/**
 * Regression tests for the review findings.
 *
 * Each block pins a specific defect that was found, adversarially verified, and fixed.
 * The titles read as the guarantee the fix restores; a failure here is a regression.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "./tool.ts"
import type { HostTools } from "./tool-runtime.ts"
import { expectFailure, expectOk, expectValue, run, runEffect, spy } from "./test-harness.ts"

describe("H1 · functions are lexical closures", () => {
  test("a counter closure retains its own private state", () =>
    expectValue(
      `const makeCounter = () => { let c = 0; return () => { c = c + 1; return c } }
       const inc = makeCounter()
       return [inc(), inc(), inc()]`,
      [1, 2, 3],
    ))

  test("curried functions capture each argument", () =>
    expectValue(`const add = (a) => (b) => a + b\nreturn add(5)(3)`, 8))

  test("an array of closures each capture their own loop binding", () =>
    expectValue(`const fns = [10, 20, 30].map((v) => () => v)\nreturn fns.map((f) => f())`, [10, 20, 30]))

  test("for-let closures capture their own iteration binding", () =>
    expectValue(`const fns = []; for (let i = 0; i < 3; i += 1) { fns[i] = () => i }; return fns.map((f) => f())`, [0, 1, 2]))

  test("a closure keeps a block-local binding alive after the block exits", () =>
    expectValue(
      `let read
       { const secret = 42; read = () => secret }
       return read()`,
      42,
    ))

  test("recursion resolves the function's own binding", () =>
    expectValue(`const fact = (n) => n <= 1 ? 1 : n * fact(n - 1)\nreturn fact(5)`, 120))

  test("a free variable with no lexical binding is unknown — no dynamic capture", () =>
    expectFailure(
      `const makeReader = () => () => x
       const reader = makeReader()
       const useIt = (fn) => { let x = 999; return fn() }
       return useIt(reader)`,
      { message: "Unknown identifier 'x'" },
    ))

  test("inline, non-escaping callbacks still see the enclosing scope", () =>
    expectValue(
      `const factor = 3
       return [1, 2, 3].map((n) => n * factor)`,
      [3, 6, 9],
    ))
})

describe("H2 · member assignment evaluates its target exactly once", () => {
  test("compound assignment on a tool member calls the tool once", async () => {
    const getBox = spy(() => ({ value: 5 }))
    const result = await run(`tools.getBox().value += 100`, { tools: { getBox } })
    expectOk(result)
    expect(getBox.count).toBe(1)
    expect(result.toolCalls.length).toBe(1)
  })

  test("a computed member key is evaluated once", async () => {
    const key = spy(() => "v")
    const result = await run(`const o = { v: 1 }\no[tools.key()] += 10\nreturn o.v`, { tools: { key } })
    expect(expectOk(result).value).toBe(11)
    expect(key.count).toBe(1)
  })

  test("increment on a tool member calls the tool once", async () => {
    const box = spy(() => ({ n: 1 }))
    const result = await run(`tools.box().n++`, { tools: { box } })
    expectOk(result)
    expect(box.count).toBe(1)
  })

  test("a stable local target still computes correctly", () =>
    expectValue(`const o = { x: 5 }\no.x += 100\nreturn o.x`, 105))
})

describe("H3 · parallel Promise.all is correct under concurrency", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))

  test("a large array-literal Promise.all is correct at the default concurrency (8)", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await run(
        `const xs = tools.list()
         return Promise.all([tools.count(xs.map((q) => q.id)), tools.count(xs.map((w) => w.id))])`,
        { tools: { list: () => items(1000), count: (xs: unknown) => (xs as Array<unknown>).length } },
      )
      expect(expectOk(result).value).toEqual([1000, 1000])
    }
  })

  test("Promise.all preserves source order regardless of settle time", () =>
    expectValue(
      `return Promise.all([tools.delay(30, "a"), tools.delay(1, "b"), tools.delay(15, "c")])`,
      ["a", "b", "c"],
      { tools: { delay: (ms: unknown, v: unknown) => new Promise((resolve) => setTimeout(() => resolve(v), ms as number)) } },
    ))

  test("the mapped Promise.all form is correct for large inputs", async () => {
    const result = await run(
      `const xs = tools.list()\nreturn Promise.all(xs.map((x) => tools.echo(x.id)))`,
      { tools: { list: () => items(300), echo: (id: unknown) => id }, limits: { maxToolCalls: 1000 } },
    )
    expect(expectOk(result).value).toEqual(Array.from({ length: 300 }, (_, i) => i))
  })
})

describe("H4 · maxDataBytes bounds every output that crosses the boundary", () => {
  const big = (size: number) =>
    Tool.make({
      description: "returns a blob",
      input: Schema.Struct({}),
      output: Schema.Struct({ data: Schema.String }),
      run: () => Effect.succeed({ data: "x".repeat(size) }),
    })

  test("a described (schema) tool's output is bounded", async () => {
    const result = await runEffect(`return tools.blob({})`, { tools: { blob: big(5000) }, limits: { maxDataBytes: 100 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("a plain-function tool's output is bounded", async () => {
    const result = await run(`return tools.blob()`, { tools: { blob: () => "x".repeat(5000) }, limits: { maxDataBytes: 100 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("tools.search results are bounded", async () => {
    const tools: HostTools = {}
    for (let i = 0; i < 200; i += 1) {
      tools[`capability_${i}`] = Tool.make({
        description: "a deliberately verbose capability description ".repeat(4),
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        run: () => Effect.succeed({}),
      })
    }
    const result = await runEffect(`return tools.search({ limit: 200 })`, { tools, limits: { maxDataBytes: 256 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("the final program result is bounded even when assembled in-program", async () => {
    const result = await run(`const s = tools.s()\nreturn s + s`, {
      tools: { s: () => "x".repeat(200) },
      limits: { maxDataBytes: 300 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("string intrinsics reject oversized intermediate values before they can be discarded", async () => {
    const repeated = await run(`const hidden = "x".repeat(10_000); return "small"`, { limits: { maxDataBytes: 100 } })
    expect(repeated.ok).toBe(false)
    if (!repeated.ok) expect(repeated.error.kind).toBe("InvalidDataValue")

    const replaced = await run(`const hidden = "----".replaceAll("-", "xxxxxxxxxx"); return "small"`, { limits: { maxDataBytes: 20 } })
    expect(replaced.ok).toBe(false)
    if (!replaced.ok) expect(replaced.error.kind).toBe("InvalidDataValue")

    const split = await run(`const hidden = "abcdef".split(""); return "small"`, { limits: { maxCollectionLength: 4 } })
    expect(split.ok).toBe(false)
    if (!split.ok) expect(split.error.kind).toBe("InvalidDataValue")
  })

  test("pure array and object intrinsics enforce configured intermediate limits", async () => {
    const expanded = await run(`const hidden = [1, 2, 3].flatMap((n) => [n, n]); return null`, {
      limits: { maxCollectionLength: 4 },
    })
    expect(expanded.ok).toBe(false)
    if (!expanded.ok) expect(expanded.error.kind).toBe("InvalidDataValue")

    const entries = await run(`const hidden = Object.entries({ first: "1234567890", second: "1234567890" }); return null`, {
      limits: { maxDataBytes: 30 },
    })
    expect(entries.ok).toBe(false)
    if (!entries.ok) expect(entries.error.kind).toBe("InvalidDataValue")

    const concatenated = await run(`const value = "1234567890"; const hidden = [value].concat([value]); return null`, {
      limits: { maxDataBytes: 20 },
    })
    expect(concatenated.ok).toBe(false)
    if (!concatenated.ok) expect(concatenated.error.kind).toBe("InvalidDataValue")
  })

  test("ordinary expressions cannot hide oversized intermediate data", async () => {
    const concatenated = await run(`const hidden = "1234567890" + "1234567890"; return null`, { limits: { maxDataBytes: 15 } })
    expect(concatenated.ok).toBe(false)
    if (!concatenated.ok) expect(concatenated.error.kind).toBe("InvalidDataValue")

    const templated = await run('const part = "1234567890"; const hidden = `${part}${part}`; return null', { limits: { maxDataBytes: 15 } })
    expect(templated.ok).toBe(false)
    if (!templated.ok) expect(templated.error.kind).toBe("InvalidDataValue")

    const array = await run(`const hidden = [...[1, 2], ...[3, 4]]; return null`, { limits: { maxCollectionLength: 3 } })
    expect(array.ok).toBe(false)
    if (!array.ok) expect(array.error.kind).toBe("InvalidDataValue")

    const object = await run(`const hidden = { a: 1, b: 2 }; return null`, { limits: { maxCollectionLength: 1 } })
    expect(object.ok).toBe(false)
    if (!object.ok) expect(object.error.kind).toBe("InvalidDataValue")

    const oversizedObject = await run(`const value = "1234567890"; const hidden = { a: value, b: value }; return null`, { limits: { maxDataBytes: 30 } })
    expect(oversizedObject.ok).toBe(false)
    if (!oversizedObject.ok) expect(oversizedObject.error.kind).toBe("InvalidDataValue")
  })

  test("sparse array writes cannot bypass collection limits", async () => {
    const result = await run(`const values = []; values[1000] = 1; return null`, { limits: { maxCollectionLength: 10 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("local closures do not disable byte or cycle checks on containing data", async () => {
    const mixed = await run(`const fn = () => 1; const value = "1234567890"; const hidden = [fn, value, value]; return null`, {
      limits: { maxDataBytes: 20 },
    })
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.error.kind).toBe("InvalidDataValue")

    const cyclic = await run(`const values = []; values[0] = values; return null`)
    expect(cyclic.ok).toBe(false)
    if (!cyclic.ok) expect(cyclic.error.kind).toBe("InvalidDataValue")
  })

  test("Promise.all evaluates direct-call arguments in source order before concurrent invocation", async () => {
    const result = await run(`let i = 0; const values = Promise.all([tools.echo(i++), tools.echo(i++)]); return values`, {
      tools: { echo: (value: unknown) => value },
    })
    expect(expectOk(result).value).toEqual([0, 1])
  })

  test("failed writes are atomic when a caught limit error rejects the next value", async () => {
    const object = await run(`const value = "1234567890"; const out = { a: value }; try { out.b = value } catch (error) {}; return out.b ?? "missing"`, {
      limits: { maxDataBytes: 25 },
    })
    expect(expectOk(object).value).toBe("missing")

    const array = await run(`const value = "1234567890"; const out = [value]; try { out[1] = value } catch (error) {}; return out.length`, {
      limits: { maxDataBytes: 25 },
    })
    expect(expectOk(array).value).toBe(1)

    const compound = await run(`const out = { text: "1234567890" }; try { out.text += "1234567890" } catch (error) {}; return out.text`, {
      limits: { maxDataBytes: 25 },
    })
    expect(expectOk(compound).value).toBe("1234567890")
  })

  test("Promise.all validates shape and aggregate output before exposing work", async () => {
    let nestedCalls = 0
    const malformed = await run(`return Promise.all([tools.outer(tools.nested()), "invalid"])`, {
      tools: {
        nested: () => { nestedCalls += 1; return 1 },
        outer: (value: unknown) => value,
      },
    })
    expect(malformed.ok).toBe(false)
    expect(nestedCalls).toBe(0)

    const direct = await run(`const hidden = Promise.all([tools.blob(), tools.blob()]); return null`, {
      tools: { blob: () => "x".repeat(60) },
      limits: { maxDataBytes: 100 },
    })
    expect(direct.ok).toBe(false)
    if (!direct.ok) expect(direct.error.kind).toBe("InvalidDataValue")

    const mapped = await run(`const items = [1, 2]; const hidden = Promise.all(items.map((item) => tools.blob(item))); return null`, {
      tools: { blob: () => "x".repeat(60) },
      limits: { maxDataBytes: 100 },
    })
    expect(mapped.ok).toBe(false)
    if (!mapped.ok) expect(mapped.error.kind).toBe("InvalidDataValue")
  })

  test("comparator sorting scales as merge sort rather than insertion sort", async () => {
    const values = Array.from({ length: 64 }, (_, index) => 64 - index).join(", ")
    const result = await run(`let comparisons = 0; [${values}].sort((left, right) => { comparisons += 1; return left - right }); return comparisons`)
    expect(Number(expectOk(result).value)).toBeLessThan(500)
  })
})

describe("M1 · diagnostics never carry a host stack", () => {
  test("an interpreter error exposes no stack", async () => {
    const result = await expectFailure(`return notDefined`)
    expect("stack" in result.error).toBe(false)
  })

  test("a throwing host tool exposes no stack and no host path", async () => {
    const result = await run(`return tools.boom()`, {
      tools: {
        boom: () => {
          throw new Error("failure at /Users/secret/path")
        },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect("stack" in result.error).toBe(false)
      expect(result.error.message).not.toContain("/Users/secret/path")
    }
  })
})

describe("M2 · runaway recursion fails gracefully", () => {
  test("a stack overflow never leaks the raw host message and carries no stack", async () => {
    const result = await run(`const f = (n) => f(n + 1)\nreturn f(0)`, {
      limits: { maxOperations: 1_000_000_000, timeoutMs: 5_000 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).not.toContain("Maximum call stack")
      expect("stack" in result.error).toBe(false)
    }
  }, 10_000)

  test("a modest operation budget stops recursion with a clean diagnostic", async () => {
    const result = await run(`const f = (n) => f(n + 1)\nreturn f(0)`, { limits: { maxOperations: 50_000 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("OperationLimitExceeded")
  })
})

describe("M5 · finally observes abrupt completion", () => {
  test("a return inside finally overrides the try result", () =>
    expectValue(`const f = () => { try { return "try" } finally { return "finally" } }\nreturn f()`, "finally"))

  test("a break inside finally overrides a pending throw", () =>
    expectValue(
      `let reached = "no"
       for (const x of [1, 2, 3]) { try { throw "boom" } finally { break } }
       reached = "yes"
       return reached`,
      "yes",
    ))

  test("a bare expression in finally does not override a normal return", () =>
    expectValue(`const f = () => { try { return 1 } finally { 99 } }\nreturn f()`, 1))

  test("finally still runs its side effects on the success path", async () => {
    const log = spy(() => null)
    const result = await run(`const f = () => { try { return 7 } finally { tools.log("cleanup") } }\nreturn f()`, {
      tools: { log },
    })
    expect(expectOk(result).value).toBe(7)
    expect(log.count).toBe(1)
  })
})

describe("M6 · optional chaining short-circuits the whole chain", () => {
  test("a?.b.c yields undefined when a is nullish", () =>
    expectValue(`const a = null\nreturn a?.b.c ?? "fallback"`, "fallback"))

  test("a present chain reads all the way through", () =>
    expectValue(`const o = { b: { c: 42 } }\nreturn o?.b.c`, 42))

  test("an optional call short-circuits when the receiver is nullish", () =>
    expectValue(`const a = null\nreturn a?.go() ?? "ok"`, "ok"))

  test("optional chaining over a nullish tool result", async () => {
    const result = await run(`const r = tools.maybe()\nreturn r?.items[0]?.name ?? "none"`, {
      tools: { maybe: () => null },
    })
    expect(expectOk(result).value).toBe("none")
  })

  test("optional chaining over a present tool result reads through", async () => {
    const result = await run(`const r = tools.maybe()\nreturn r?.items[0]?.name ?? "none"`, {
      tools: { maybe: () => ({ items: [{ name: "found" }] }) },
    })
    expect(expectOk(result).value).toBe("found")
  })
})
