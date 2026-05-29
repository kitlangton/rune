/**
 * Confinement tests — the security boundary.
 *
 * Rune runs untrusted, agent-authored code. Its promise is that a program can reach
 * only plain data and explicit `tools.*` capabilities: no ambient globals, no native
 * prototypes, no prototype pollution, no live/native value across the seam. Every test
 * here is an attack that MUST be refused.
 */
import { describe, expect, test } from "bun:test"
import { expectFailure, run } from "./test-harness.ts"

describe("ambient host capabilities are unreachable", () => {
  test.each([
    "globalThis",
    "process",
    "require",
    "eval",
    "Function",
    "console",
    "Bun",
    "fetch",
    "setTimeout",
    "global",
    "window",
  ])("`%s` is an unknown identifier", (name) =>
    expectFailure(`return ${name}`, { message: /Unknown identifier|not supported/ }))
})

describe("native prototypes and constructors are blocked", () => {
  test.each([
    `return [].constructor`,
    `return ({}).constructor`,
    `return (1).constructor`,
    `return ("s").constructor`,
    `return (true).constructor`,
    `return [].__proto__`,
    `return ({}).__proto__`,
    `return [].constructor.constructor("return globalThis")()`,
  ])("blocks %s", (code) => expectFailure(code, { message: /not available in Rune|Cannot access a property/ }))

  test("a string-built 'constructor' key is still blocked", () =>
    expectFailure(`const o = { a: 1 }\nreturn o["constr" + "uctor"]`, { message: "not available in Rune" }))

  test("a string-built '__proto__' key is still blocked", () =>
    expectFailure(`const o = { a: 1 }\nreturn o["__pro" + "to__"]`, { message: "not available in Rune" }))
})

describe("prototype pollution writes are refused", () => {
  test.each([
    `const o = {}\no.__proto__ = { polluted: true }\nreturn o`,
    `const o = {}\no["__proto__"] = { polluted: true }\nreturn o`,
    `const o = {}\no["__pro" + "to__"] = { polluted: true }\nreturn o`,
    `const o = {}\no.constructor = 1\nreturn o`,
    `const a = []\na["__proto__"] = { polluted: true }\nreturn a`,
  ])("refuses %s", (code) => expectFailure(code, { message: "not available in Rune" }))

  test("a pollution attempt does not leak onto fresh objects", async () => {
    // Even though the write is refused, prove the global prototype is untouched.
    const before = ({} as Record<string, unknown>).polluted
    await run(`const o = {}\no["__proto__"] = { polluted: true }\nreturn o`)
    expect(({} as Record<string, unknown>).polluted).toBe(before as undefined)
  })
})

describe("destructuring cannot reach blocked members", () => {
  test("object destructuring of `constructor` is blocked", () =>
    expectFailure(`const { constructor } = { a: 1 }\nreturn constructor`, { message: "not available in Rune" }))

  test("object destructuring of `__proto__` is blocked", () =>
    expectFailure(`const { __proto__ } = { a: 1 }\nreturn __proto__`, { message: "not available in Rune" }))
})

describe("capability references cannot escape as values", () => {
  test.each([
    `return tools`,
    `return tools.anything`,
    `return [].map`,
    `return Promise`,
    `return Promise.all`,
  ])("refuses to return %s", (code) => expectFailure(code, { kind: "InvalidDataValue" }))

  test("a capability reference cannot be smuggled out as a tool argument", async () => {
    const result = await run(`tools.sink(tools)\nreturn null`, { tools: { sink: () => null } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test.each([
    `return Object.keys(tools.secret)`,
    `return String(tools.secret)`,
    `return Boolean(tools.secret)`,
    `return JSON.stringify(tools.secret)`,
    `return \`${"${tools.secret}"}\``,
    `return [tools.secret].join(",")`,
    `return tools.secret + ""`,
  ])("built-in transformations cannot inspect a capability reference: %s", (code) =>
    expectFailure(code, { kind: "InvalidDataValue" }))

  test.each([
    `const fn = () => 1; return fn.body`,
    `const fn = () => 1; const { body } = fn; return body`,
    `const fn = () => 1; return { ...fn }`,
    `const method = [1].map; return method.name`,
    `const method = Math.abs; return method.name`,
    `const cast = String; cast.name = "Boolean"; return cast("x")`,
  ])("captured runtime references remain opaque: %s", (code) =>
    expectFailure(code, { kind: "InvalidDataValue" }))
})

describe("only data values cross the capability boundary", () => {
  const exotic: ReadonlyArray<readonly [string, () => unknown]> = [
    ["a Date", () => new Date()],
    ["a Map", () => new Map()],
    ["a Set", () => new Set()],
    ["a RegExp", () => /x/],
    ["a function", () => () => 1],
    ["a class instance", () => new (class Secret {})()],
    ["a bigint", () => 1n],
    ["a symbol", () => Symbol("x")],
    ["a non-finite number", () => Infinity],
  ]

  test.each(exotic)("rejects a tool returning %s", async (_label, make) => {
    const result = await run(`return tools.x()`, { tools: { x: make } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("a getter on a tool result is flattened to a plain value, not left live", async () => {
    let reads = 0
    const withGetter = () => ({
      get live() {
        reads += 1
        return 42
      },
    })
    const result = await run(`const r = tools.x()\nreturn r.live + r.live`, { tools: { x: withGetter } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(84)
    // The getter ran exactly once, at the boundary — the program never holds a live getter.
    expect(reads).toBe(1)
  })
})

describe("circular and oversized data are rejected at the seam", () => {
  test("a circular tool result is rejected", async () => {
    const cyclic = () => {
      const o: Record<string, unknown> = {}
      o.self = o
      return o
    }
    const result = await run(`return tools.x()`, { tools: { x: cyclic } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("InvalidDataValue")
  })

  test("a shared but acyclic (diamond) graph is NOT mistaken for circular", async () => {
    const diamond = () => {
      const shared = { value: 1 }
      return { left: shared, right: shared }
    }
    const result = await run(`const r = tools.x()\nreturn r.left.value + r.right.value`, { tools: { x: diamond } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(2)
  })
})
