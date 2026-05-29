import { describe, expect, test } from "bun:test"
import { expectFailure, expectValue } from "./test-harness.ts"

describe("array methods agents reach for", () => {
  test.each([
    ["reduce", `return [1, 2, 3].reduce((total, value) => total + value, 0)`, 6],
    ["flatMap", `return [[1], [2]].flatMap((values) => values)`, [1, 2]],
    ["forEach", `let total = 0; [1, 2].forEach((value) => { total += value }); return total`, 3],
    ["sort", `return [3, 1, 2].sort((a, b) => a - b)`, [1, 2, 3]],
  ])("Array.%s evaluates", (_method, code, expected) => expectValue(code, expected))

  test("the for...of accumulator rewrite still works", () =>
    expectValue(`let total = 0; for (const value of [1, 2, 3]) { total += value }; return total`, 6))
})

describe("agent retry diagnostics for still-unsupported methods", () => {
  test.each([
    ["splice", `return [1, 2, 3].splice(0, 1)`],
    ["reduceRight", `return [1, 2].reduceRight((a, b) => a + b)`],
  ])("Array.%s returns a retryable rewrite hint", async (_method, code) => {
    const failure = await expectFailure(code, { kind: "UnsupportedSyntax" })
    expect(failure.error.message).toContain("Rewrite using")
    expect(failure.error.suggestions?.length).toBeGreaterThan(0)
  })
})
