/**
 * Property-based tests.
 *
 * These assert Rune's *contract* over thousands of generated inputs rather than a
 * handful of examples:
 *
 *  1. Differential — for the pure subset, Rune means exactly what JavaScript means.
 *  2. Boundary    — any Data Value crosses to a tool and back unchanged.
 *  3. Totality    — every input resolves to a well-formed result; the host never leaks.
 *  4. Limits      — configured budgets are always honored.
 */
import { describe, test } from "bun:test"
import { Arb, expectOk, fc, isWellFormedResult, expectMatchesJs, run, spy } from "./test-harness.ts"
import { expect } from "bun:test"

describe("differential: Rune evaluates the pure subset exactly like JavaScript", () => {
  test("random expressions agree with the JavaScript oracle", async () => {
    await fc.assert(
      fc.asyncProperty(Arb.expression, (source) => expectMatchesJs(source)),
      { numRuns: 250 },
    )
  }, 30_000)

  test("random string transformations agree with JavaScript", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 40 }),
        fc.string({ maxLength: 5 }),
        fc.string({ maxLength: 5 }),
        async (value, search, replacement) => {
          const source = `${JSON.stringify(value)}.trim().toLowerCase().replaceAll(${JSON.stringify(search)}, ${JSON.stringify(replacement)})`
          await expectMatchesJs(source)
        },
      ),
      { numRuns: 150 },
    )
  }, 30_000)

  test("random non-mutating array transformations agree with JavaScript", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -100, max: 100 }), { maxLength: 20 }),
        fc.integer({ min: -20, max: 20 }),
        fc.integer({ min: -20, max: 20 }),
        async (values, start, end) => {
          const source = `${JSON.stringify(values)}.slice(${start}, ${end}).reverse().join(",")`
          await expectMatchesJs(source)
        },
      ),
      { numRuns: 150 },
    )
  }, 30_000)

  test("random record traversal agrees with JavaScript", async () => {
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string({ maxLength: 8 }).filter((key) => !["__proto__", "constructor", "prototype"].includes(key)), fc.integer()), async (record) => {
        const result = await run(`return Object.entries(${JSON.stringify(record)})`)
        expect(expectOk(result).value).toEqual(Object.entries(record))
      }),
      { numRuns: 150 },
    )
  }, 30_000)
})

describe("boundary: Data Values survive the capability seam unchanged", () => {
  test("a value returned by a tool round-trips to the program result", async () => {
    await fc.assert(
      fc.asyncProperty(Arb.dataValue, async (value) => {
        const result = await run(`return tools.source()`, { tools: { source: () => value } })
        expect(expectOk(result).value).toEqual(value)
      }),
      { numRuns: 200 },
    )
  }, 30_000)

  test("a value passed as a tool argument arrives unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(Arb.dataValue, async (value) => {
        const sink = spy((_received: unknown) => null)
        const result = await run(`tools.sink(tools.source()); return null`, {
          tools: { source: () => value, sink },
        })
        expectOk(result)
        expect(sink.calls[0]?.[0]).toEqual(value)
      }),
      { numRuns: 200 },
    )
  }, 30_000)
})

describe("totality: every input resolves to a well-formed result", () => {
  test("arbitrary source never throws and never leaks a host stack", async () => {
    const sources = fc.oneof(
      fc.string(),
      Arb.expression.map((expr) => `return (${expr})`),
      Arb.expression.map((expr) => `const x = ${expr}\nreturn x`),
      fc.constantFrom("return", "}{", "tools", "tools.x(", "while (1) {}", "тест 🎉", "/* unterminated", "const = ;"),
    )
    await fc.assert(
      fc.asyncProperty(sources, async (code) => {
        const result = await run(code)
        expect(isWellFormedResult(result)).toBe(true)
      }),
      { numRuns: 300 },
    )
  }, 30_000)
})

describe("limits: configured budgets are always honored", () => {
  test("maxToolCalls caps both invocations and the recorded audit log", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 12 }), async (max) => {
        const tool = spy(() => 1)
        const result = await run(`let i = 0\nwhile (i < 50) { tools.t(); i = i + 1 }`, {
          tools: { t: tool },
          limits: { maxToolCalls: max },
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.kind).toBe("ToolCallLimitExceeded")
        expect(result.toolCalls.length).toBe(max)
        expect(tool.count).toBe(max)
      }),
      { numRuns: 100 },
    )
  }, 30_000)

  test("an unbounded loop always trips the operation budget", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 500 }), async (max) => {
        const result = await run(`while (true) {}`, { limits: { maxOperations: max } })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.kind).toBe("OperationLimitExceeded")
      }),
      { numRuns: 60 },
    )
  }, 30_000)
})
