/**
 * Newly supported language surface (discovered via a runtime gap-probe and ranked by
 * how often agents write each idiom). Every test here pins an idiom that previously
 * hard-errored. Behavior matches JavaScript except where Rune is deliberately stricter
 * (noted inline) or non-mutating (sort/reverse — see edge-cases.test.ts).
 */
import { describe, expect, test } from "bun:test"
import { expectFailure, expectOk, expectValue, run } from "./test-harness.ts"

describe("default + rest parameters", () => {
  test("default parameters fill in for missing/undefined args", async () => {
    await expectValue(`const f = (a, b = 10) => a + b\nreturn f(5)`, 15)
    await expectValue(`const f = (a, b = 10) => a + b\nreturn f(5, 1)`, 6)
    await expectValue(`const f = (x = 0) => x\nreturn f(undefined)`, 0)
  })

  test("a default expression is only evaluated when needed", async () => {
    const result = await run(`const f = (x = tools.fallback()) => x\nreturn [f(1), f()]`, {
      tools: { fallback: () => 99 },
    })
    expect(expectOk(result).value).toEqual([1, 99])
    // fallback() ran exactly once — only for the omitted argument.
    expect(result.ok && result.toolCalls.length).toBe(1)
  })

  test("rest parameters collect the remaining arguments", async () => {
    await expectValue(`const f = (first, ...rest) => rest.length\nreturn f(1, 2, 3, 4)`, 3)
    await expectValue(`const sum = (...xs) => xs.reduce((a, b) => a + b, 0)\nreturn sum(1, 2, 3)`, 6)
  })

  test("destructured parameters, with defaults", async () => {
    await expectValue(`const f = ({ id, name }) => id + ":" + name\nreturn f({ id: 7, name: "x" })`, "7:x")
    await expectValue(`const f = ({ x = 1 } = {}) => x\nreturn f()`, 1)
    await expectValue(`const f = ([a, b]) => a + b\nreturn f([3, 4])`, 7)
  })
})

describe("rest + default destructuring", () => {
  test("array rest binds the tail", () => expectValue(`const [head, ...tail] = [1, 2, 3, 4]\nreturn tail`, [2, 3, 4]))

  test("object rest gathers the remaining keys", () =>
    expectValue(`const { a, ...others } = { a: 1, b: 2, c: 3 }\nreturn others`, { b: 2, c: 3 }))

  test("destructuring defaults", async () => {
    await expectValue(`const { limit = 10 } = {}\nreturn limit`, 10)
    await expectValue(`const { limit = 10 } = { limit: 5 }\nreturn limit`, 5)
  })

  test("nested destructuring with rest", () =>
    expectValue(`const { data: { items, ...meta } } = { data: { items: [1], page: 2 } }\nreturn [items, meta]`, [[1], { page: 2 }]))

  test("the canonical Object.entries loop", () =>
    expectValue(
      `let s = ""\nfor (const [k, v] of Object.entries({ a: 1, b: 2 })) s += k + v\nreturn s`,
      "a1b2",
    ))
})

describe("undefined literal + presence checks", () => {
  test("undefined is bound", async () => {
    await expectValue(`return undefined ?? "fallback"`, "fallback")
    await expectValue(`return typeof undefined`, "undefined")
  })

  test("the in operator checks property presence", () =>
    expectValue(`const o = { a: 1 }\nreturn ["a" in o, "b" in o]`, [true, false]))

  test("!== undefined presence check", () => expectValue(`const o = { a: 1 }\nreturn [o.a !== undefined, o.b !== undefined]`, [true, false]))
})

describe("logical assignment", () => {
  test("??= assigns only when nullish", async () => {
    await expectValue(`let x = null\nx ??= 5\nreturn x`, 5)
    await expectValue(`let x = 0\nx ??= 5\nreturn x`, 0)
  })

  test("||= and &&=", async () => {
    await expectValue(`const o = {}\no.a ||= 7\nreturn o.a`, 7)
    await expectValue(`let x = 1\nx &&= 2\nreturn x`, 2)
  })

  test("??= does not evaluate the right-hand side when not needed", async () => {
    const result = await run(`let x = 1\nx ??= tools.boom()\nreturn x`, {
      tools: { boom: () => { throw new Error("should not run") } },
    })
    expect(expectOk(result).value).toBe(1)
    expect(result.ok && result.toolCalls.length).toBe(0)
  })
})

describe("number methods", () => {
  test("toFixed / toPrecision / toExponential", async () => {
    await expectValue(`return (19.99).toFixed(2)`, "19.99")
    await expectValue(`return (1 / 3).toFixed(3)`, "0.333")
    await expectValue(`return (123.456).toPrecision(4)`, "123.5")
  })

  test("toString with a radix", async () => {
    await expectValue(`return (255).toString(16)`, "ff")
    await expectValue(`return (5).toString(2)`, "101")
  })

  test("formatting in a realistic report", async () => {
    const result = await run(
      `const total = tools.rows().reduce((sum, r) => sum + r.amount, 0)
       return "Total: $" + total.toFixed(2)`,
      { tools: { rows: () => [{ amount: 10.5 }, { amount: 4.25 }] } },
    )
    expect(expectOk(result).value).toBe("Total: $14.75")
  })
})

describe("string methods (substring / charCodeAt / codePointAt)", () => {
  test("substring and substr", async () => {
    await expectValue(`return "abcdef".substring(1, 3)`, "bc")
    await expectValue(`return "abcdef".substr(1, 2)`, "bc")
  })

  test("character codes", async () => {
    await expectValue(`return "A".charCodeAt(0)`, 65)
    await expectValue(`return "A".codePointAt(0)`, 65)
  })
})

describe("array accumulation (push/pop/shift/unshift)", () => {
  test("push accumulates and returns the new length", async () => {
    await expectValue(`const out = []\nfor (const x of [1, 2, 3]) out.push(x * 2)\nreturn out`, [2, 4, 6])
    await expectValue(`const a = [1]\nconst n = a.push(2, 3)\nreturn [n, a]`, [3, [1, 2, 3]])
  })

  test("pop / shift / unshift", async () => {
    await expectValue(`const a = [1, 2, 3]\nconst x = a.pop()\nreturn [x, a]`, [3, [1, 2]])
    await expectValue(`const a = [1, 2, 3]\nconst x = a.shift()\nreturn [x, a]`, [1, [2, 3]])
    await expectValue(`const a = [2, 3]\na.unshift(0, 1)\nreturn a`, [0, 1, 2, 3])
  })
})

describe("array methods: callback arity + ES2023 non-mutating", () => {
  test("callbacks receive (item, index, array) — the canonical dedup works", () =>
    expectValue(`return [3, 1, 3, 2, 1].filter((v, i, a) => a.indexOf(v) === i)`, [3, 1, 2]))

  test("findLast / findLastIndex", async () => {
    await expectValue(`return [1, 2, 3, 4].findLast((n) => n < 3)`, 2)
    await expectValue(`return [1, 2, 3, 4].findLastIndex((n) => n < 3)`, 1)
  })

  test("reduceRight", () => expectValue(`return [1, 2, 3].reduceRight((acc, x) => acc + x, "")`, "321"))

  test("toSorted / toReversed / with do not mutate the source", async () => {
    await expectValue(`const a = [3, 1, 2]\nconst b = a.toSorted((x, y) => x - y)\nreturn [a, b]`, [[3, 1, 2], [1, 2, 3]])
    await expectValue(`const a = [1, 2, 3]\nreturn [a.toReversed(), a]`, [[3, 2, 1], [1, 2, 3]])
    await expectValue(`const a = [1, 2, 3]\nreturn [a.with(1, 9), a]`, [[1, 9, 3], [1, 2, 3]])
  })
})

describe("Object.hasOwn", () => {
  test("checks own-property presence", () =>
    expectValue(`return [Object.hasOwn({ a: 1 }, "a"), Object.hasOwn({ a: 1 }, "b")]`, [true, false]))
})

describe("error signaling", () => {
  test("an uncaught structured throw is serialized into the diagnostic", async () => {
    const result = await run(`throw { code: "INVALID", detail: "id must be positive" }`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe(`Uncaught: {"code":"INVALID","detail":"id must be positive"}`)
  })

  test("an uncaught string throw shows the string", async () => {
    const result = await run(`throw "bad id"`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe("Uncaught: bad id")
  })

  test("new Error(message) builds a catchable error object", async () => {
    await expectValue(`try { throw new Error("boom") } catch (e) { return e.message }`, "boom")
    await expectValue(`try { throw new TypeError("nope") } catch (e) { return [e.name, e.message] }`, ["TypeError", "nope"])
  })

  test("an uncaught new Error surfaces its message", async () => {
    const result = await run(`throw new Error("kaboom")`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe("Uncaught: kaboom")
  })

  test("new on a non-error constructor is still rejected", () => expectFailure(`return new Map()`, { kind: "UnsupportedSyntax" }))
})

describe("string spread + bitwise operators", () => {
  test("spreading a string yields characters", async () => {
    await expectValue(`return [...'abc']`, ["a", "b", "c"])
    await expectValue(`const f = (...xs) => xs.length\nreturn f(...'abcd')`, 4)
  })

  test("bitwise operators (flags, masks, shifts)", async () => {
    await expectValue(`return [5 & 3, 5 | 2, 5 ^ 1, ~5]`, [1, 7, 4, -6])
    await expectValue(`return [1 << 4, 255 >> 4, -1 >>> 28]`, [16, 15, 15])
    await expectValue(`let x = 6\nx &= 3\nreturn x`, 2)
    await expectValue(`const R = 1, W = 2, X = 4\nconst perms = R | X\nreturn [(perms & W) !== 0, (perms & X) !== 0]`, [false, true])
  })
})

describe("Number / String statics", () => {
  test("Number predicates and constants", async () => {
    await expectValue(`return [Number.isInteger(5), Number.isInteger(5.5)]`, [true, false])
    await expectValue(`return Number.isSafeInteger(Number.MAX_SAFE_INTEGER)`, true)
    await expectValue(`return Number.parseInt("ff", 16)`, 255)
  })

  test("String.fromCharCode / fromCodePoint", async () => {
    await expectValue(`return String.fromCharCode(72, 105)`, "Hi")
    await expectValue(`return String.fromCodePoint(97, 98)`, "ab")
  })

  test("non-static members of Number/String stay opaque", async () => {
    await expectFailure(`return String.name`, { kind: "InvalidDataValue" })
    await expectFailure(`const c = String\nc.name = "X"\nreturn c("x")`, { kind: "InvalidDataValue" })
  })
})

describe("confinement still holds for the new surface", () => {
  test.each([
    [`return "x" in tools`, "the in operator over a capability"],
    [`return tools.secret.toFixed(2)`, "number method on a capability (extends the tool path)"],
    [`const a = []\na.push(tools)\nreturn a`, "pushing a capability into an array"],
    [`const { ...rest } = tools\nreturn rest`, "object-rest over a capability"],
  ])("rejects %s — %s", (code) => expectFailure(code))
})
