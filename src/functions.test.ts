/**
 * Function declarations and expressions.
 *
 * Arrow functions already gave agents inner abstractions; declarations add the familiar
 * `function name(...) {}` form WITH hoisting, so a program can call a helper defined
 * further down (the way agents naturally write "main logic up top, helpers below").
 */
import { describe, expect, test } from "bun:test"
import { expectFailure, expectValue, run } from "./test-harness.ts"

describe("function declarations", () => {
  test("a plain declaration is callable", () => expectValue(`function double(x) { return x * 2 }\nreturn double(5)`, 10))

  test("declarations are hoisted — callable before their definition", () =>
    expectValue(`return helper(5)\nfunction helper(x) { return x * 2 }`, 10))

  test("recursion resolves the function's own name", () =>
    expectValue(`function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) }\nreturn fact(5)`, 120))

  test("mutual recursion works because both are hoisted", () =>
    expectValue(
      `function isEven(n) { return n === 0 ? true : isOdd(n - 1) }
       function isOdd(n) { return n === 0 ? false : isEven(n - 1) }
       return isEven(10)`,
      true,
    ))

  test("declarations support default and rest parameters", async () => {
    await expectValue(`function f(x, y = 10) { return x + y }\nreturn f(5)`, 15)
    await expectValue(`function f(...xs) { return xs.length }\nreturn f(1, 2, 3)`, 3)
  })

  test("inner declarations are scoped to their function body", () =>
    expectValue(`function outer() { function inner() { return 1 }\nreturn inner() }\nreturn outer()`, 1))
})

describe("function expressions", () => {
  test("anonymous function expression", () => expectValue(`const f = function(x) { return x + 1 }\nreturn f(4)`, 5))

  test("function expressions close over their defining scope", () =>
    expectValue(`function makeAdder(a) { return function(b) { return a + b } }\nreturn makeAdder(3)(4)`, 7))
})

describe("helpers compose like the agent would write them", () => {
  test("main logic up top, helper below", async () => {
    const result = await run(
      `return summarize(tools.issues())

       function summarize(issues) {
         const urgent = issues.filter((i) => i.priority >= 3).map((i) => i.title)
         return { count: urgent.length, titles: urgent }
       }`,
      { tools: { issues: () => [{ priority: 3, title: "a" }, { priority: 1, title: "b" }, { priority: 5, title: "c" }] } },
    )
    expect(result.ok && result.value).toEqual({ count: 2, titles: ["a", "c"] })
  })
})

describe("unsupported function forms fail gracefully", () => {
  test("generator functions are rejected with a retryable hint", () =>
    expectFailure(`function* g() { yield 1 }\nreturn 1`, { kind: "UnsupportedSyntax", message: "Generator functions" }))

  test("a returned function cannot escape as a value", async () => {
    const result = await run(`return function() { return 1 }`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })
})
