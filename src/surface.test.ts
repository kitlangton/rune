/**
 * The language surface — living documentation.
 *
 * Rune supports a TypeScript-shaped SUBSET. This suite pins three things:
 *  1. what the subset currently evaluates (a concise, representative map),
 *  2. that everything OUTSIDE the subset fails *gracefully* with a structured,
 *     retryable diagnostic — the property that lets an agent rewrite and retry
 *     instead of the host crashing, and
 *  3. the roadmap (`test.todo`): flip each entry to a real assertion as the
 *     feature lands.
 */
import { describe, expect, test } from "bun:test"
import type { DiagnosticKind } from "./rune.ts"
import { expectFailure, expectOk, expectValue, run } from "./test-harness.ts"

describe("supported surface", () => {
  test("arithmetic, comparison, logical, ternary, typeof", async () => {
    await expectValue(`return (2 + 3 * 4 - 1) % 5`, (2 + 3 * 4 - 1) % 5)
    await expectValue(`return 2 ** 10`, 1024)
    await expectValue(`return 1 < 2 && 3 >= 3 ? "y" : "n"`, "y")
    await expectValue(`return null ?? "fallback"`, "fallback")
    await expectValue(`return typeof "x"`, "string")
  })

  test("data + template literals", async () => {
    await expectValue(`return { a: 1, b: [2, 3], c: { d: 4 } }`, { a: 1, b: [2, 3], c: { d: 4 } })
    await expectValue("const n = 5\nreturn `n is ${n}`", "n is 5")
  })

  test("destructuring: object, nested, array with holes", async () => {
    await expectValue(`const { a, b: { c } } = { a: 1, b: { c: 2 } }\nreturn a + c`, 3)
    await expectValue(`const [x, , z] = [1, 2, 3]\nreturn x + z`, 4)
  })

  test("control flow: if / loops / break / continue", async () => {
    await expectValue(
      `let s = 0
       for (const x of [1, 2, 3, 4]) { if (x === 2) continue; if (x === 4) break; s += x }
       return s`,
      1 + 3,
    )
    await expectValue(`let i = 0\nwhile (i < 3) i += 1\nreturn i`, 3)
  })

  test("collection intrinsics: map / filter / find / some / every / includes / join", async () => {
    await expectValue(`return [1, 2, 3, 4].filter((n) => n % 2 === 0).map((n) => n * 10)`, [20, 40])
    await expectValue(`return [1, 2, 3].find((n) => n > 1)`, 2)
    await expectValue(`return [1, 2, 3].some((n) => n > 2) && [1, 2].every((n) => n > 0)`, true)
    await expectValue(`return [1, 2, 3].join("-")`, "1-2-3")
    await expectValue(`return [1, 2, 3].includes(2)`, true)
  })

  test("spread (array, object), optional chaining, closures", async () => {
    await expectValue(`return [...[1, 2], ...[3]]`, [1, 2, 3])
    await expectValue(`return { ...{ a: 1 }, b: 2 }`, { a: 1, b: 2 })
    await expectValue(`const o = null\nreturn o?.a?.b ?? "none"`, "none")
    await expectValue(`const add = (a) => (b) => a + b\nreturn add(2)(5)`, 7)
  })

  test("try / catch / throw / finally", async () => {
    await expectValue(`try { throw { code: 7 } } catch (e) { return e.code }`, 7)
    await expectValue(`const f = () => { try { return "a" } finally { return "b" } }\nreturn f()`, "b")
  })

  test("switch supports matches, fallthrough, defaults, and break", async () => {
    await expectValue(`let out = ""; switch (2) { case 1: out += "a"; break; case 2: out += "b"; case 3: out += "c"; break; default: out = "d" }; return out`, "bc")
    await expectValue(`let out = ""; switch (9) { case 1: out = "a"; break; default: out = "default" }; return out`, "default")
    await expectValue(`switch ("ok") { case "ok": return 42; default: return 0 }`, 42)
  })

  test("tool calls: sync-looking, namespaced, parallel", async () => {
    const result = await run(`const x = tools.a()\nreturn Promise.all([tools.ns.b(x), tools.ns.b(x)])`, {
      tools: { a: () => 21, ns: { b: (n: unknown) => (n as number) * 2 } },
    })
    expect(result.ok && result.value).toEqual([42, 42])
  })
})

describe("unsupported syntax fails gracefully (retryable diagnostics)", () => {
  // The core UX claim: anything outside the subset → ok:false with a known kind and a
  // message, so the agent can rewrite and retry rather than the host throwing.
  const cases: ReadonlyArray<readonly [string, string, DiagnosticKind]> = [
    ["generator function", `function* g() { yield 1 }\nreturn 1`, "UnsupportedSyntax"],
    ["class declaration", `class A {}\nreturn 1`, "UnsupportedSyntax"],
    ["for-in loop", `for (const k in { a: 1 }) {}\nreturn 1`, "UnsupportedSyntax"],
    ["new expression", `return new Date()`, "UnsupportedSyntax"],
  ]

  test.each(cases)("%s → %s diagnostic", async (_label, code, kind) => {
    const result = await expectFailure(code, { kind })
    expect(result.error.message.length).toBeGreaterThan(0)
  })

  test("regex literals are rejected as non-data", () => expectFailure(`return /x/`, { kind: "InvalidDataValue" }))

  test("a missing global names the identifier (so the agent can avoid it)", () =>
    expectFailure(`return globalThis`, { message: "Unknown identifier 'globalThis'" }))

  test("a recognized-but-unimplemented array method gives a rewrite hint", async () => {
    const result = await expectFailure(`return [1, 2, 3].splice(0, 1)`, { kind: "UnsupportedSyntax" })
    expect(result.error.message.toLowerCase()).toContain("splice")
  })
})

describe("strings", () => {
  test("length and character indexing", async () => {
    await expectValue(`return "hello".length`, 5)
    await expectValue(`return "hello"[1]`, "e")
  })

  test("case + whitespace", async () => {
    await expectValue(`return "Hi".toUpperCase()`, "HI")
    await expectValue(`return "Hi".toLowerCase()`, "hi")
    await expectValue(`return "  hi  ".trim()`, "hi")
  })

  test("search + slice", async () => {
    await expectValue(`return "a,b,c".split(",")`, ["a", "b", "c"])
    await expectValue(`return "hello".slice(1, 3)`, "el")
    await expectValue(`return "hello".includes("ell")`, true)
    await expectValue(`return "hello".startsWith("he")`, true)
    await expectValue(`return "hello".endsWith("lo")`, true)
    await expectValue(`return "hello".indexOf("l")`, 2)
    await expectValue(`return "a,b,c".split(",", 1)`, ["a"])
    await expectValue(`return "hello".includes("l", 3)`, true)
    await expectValue(`return "hello".indexOf("l", 3)`, 3)
  })

  test("transform", async () => {
    await expectValue(`return "a-b-c".replace("-", "_")`, "a_b-c")
    await expectValue(`return "a-b-c".replaceAll("-", "_")`, "a_b_c")
    await expectValue(`return "ab".repeat(3)`, "ababab")
    await expectValue(`return "5".padStart(3, "0")`, "005")
    await expectValue(`return "5".padEnd(3, "0")`, "500")
  })

  test("chaining reads like JavaScript", () =>
    expectValue(`return "  Hello World  ".trim().toLowerCase().split(" ")`, ["hello", "world"]))
})

describe("array methods", () => {
  test("reduce with and without an initial value", async () => {
    await expectValue(`return [1, 2, 3, 4].reduce((sum, n) => sum + n, 0)`, 10)
    await expectValue(`return [1, 2, 3].reduce((sum, n) => sum + n)`, 6)
  })

  test("slice / concat / indexOf / lastIndexOf / at", async () => {
    await expectValue(`return [1, 2, 3, 4].slice(1, 3)`, [2, 3])
    await expectValue(`return [1, 2].concat([3], [4, 5])`, [1, 2, 3, 4, 5])
    await expectValue(`return [1, 2, 3, 2].indexOf(2)`, 1)
    await expectValue(`return [1, 2, 3, 2].lastIndexOf(2)`, 3)
    await expectValue(`return [10, 20, 30].at(-1)`, 30)
    await expectValue(`return [1, 2, 1].indexOf(1, 1)`, 2)
    await expectValue(`return [1, 2, 1].lastIndexOf(1, 1)`, 0)
  })

  test("flat / flatMap / reverse / findIndex", async () => {
    await expectValue(`return [[1], [2, 3]].flat()`, [1, 2, 3])
    await expectValue(`return [1, 2].flatMap((n) => [n, n * 10])`, [1, 10, 2, 20])
    await expectValue(`return [1, 2, 3].reverse()`, [3, 2, 1])
    await expectValue(`return [5, 6, 7].findIndex((n) => n === 6)`, 1)
    await expectValue(`return [5, 6, 7].findIndex((n) => n === 99)`, -1)
  })

  test("sort: default (lexicographic) and with a comparator", async () => {
    await expectValue(`return ["c", "a", "b"].sort()`, ["a", "b", "c"])
    await expectValue(`return [3, 1, 2].sort((a, b) => a - b)`, [1, 2, 3])
  })

  test("reverse and sort do not mutate the source", () =>
    expectValue(`const xs = [3, 1, 2]\nconst sorted = xs.sort((a, b) => a - b)\nreturn [xs[0], sorted[0]]`, [3, 1]))
})

describe("Object / Math / JSON globals", () => {
  test("Object.keys / values / entries / fromEntries / assign", async () => {
    await expectValue(`return Object.keys({ a: 1, b: 2 })`, ["a", "b"])
    await expectValue(`return Object.values({ a: 1, b: 2 })`, [1, 2])
    await expectValue(`return Object.entries({ a: 1 })`, [["a", 1]])
    await expectValue(`return Object.fromEntries([["a", 1], ["b", 2]])`, { a: 1, b: 2 })
    await expectValue(`return Object.assign({ a: 1 }, { b: 2 })`, { a: 1, b: 2 })
    await expectValue(`return Object.fromEntries(Object.entries({ a: 1, b: 2 }))`, { a: 1, b: 2 })
  })

  test("Math.max / min / floor / ceil / round / abs / sign / sqrt / pow", async () => {
    await expectValue(`return Math.max(1, 9, 3)`, 9)
    await expectValue(`return Math.min(1, 9, 3)`, 1)
    await expectValue(`return [Math.floor(2.7), Math.ceil(2.1), Math.round(2.5)]`, [2, 3, 3])
    await expectValue(`return [Math.abs(-4), Math.sign(-3)]`, [4, -1])
    await expectValue(`return [Math.sqrt(16), Math.pow(2, 5)]`, [4, 32])
  })

  test("JSON.stringify / parse round-trip", async () => {
    await expectValue(`return JSON.stringify({ a: 1, b: [2, 3] })`, `{"a":1,"b":[2,3]}`)
    await expectValue(`return JSON.parse('{"a":1}')`, { a: 1 })
    await expectValue(`return JSON.parse(JSON.stringify({ a: [1, 2], b: "x" }))`, { a: [1, 2], b: "x" })
    await expectValue(`return JSON.stringify({ a: 1 }, null, 2)`, "{\n  \"a\": 1\n}")
    await expectValue(`return JSON.stringify({ a: 1 }, 2)`, `{"a":1}`)
  })

  test("JSON.parse cannot smuggle in prototype pollution", () =>
    expectFailure(`return JSON.parse('{"__proto__":{"x":1}}')`, { kind: "InvalidDataValue" }))
})

describe("coercion helpers", () => {
  test("Number / String / Boolean", async () => {
    await expectValue(`return Number("42")`, 42)
    await expectValue(`return Number(true)`, 1)
    await expectValue(`return [String(42), String(true), String(null)]`, ["42", "true", "null"])
    await expectValue(`return String([1, [2, 3]])`, "1,2,3")
    await expectValue(`return String({ a: 1 })`, "[object Object]")
    await expectValue(`return [Boolean(0), Boolean(""), Boolean("x")]`, [false, false, true])
  })
})

describe("composition: the kind of program an agent writes", () => {
  test("shape tool results with Object.entries + map + string methods + join", async () => {
    const result = await run(
      `const data = tools.fetch()
       return Object.entries(data)
         .map(([key, value]) => key.toUpperCase() + "=" + value)
         .join(", ")`,
      { tools: { fetch: () => ({ host: "rune", port: 443 }) } },
    )
    expect(expectOk(result).value).toBe("HOST=rune, PORT=443")
  })
})
