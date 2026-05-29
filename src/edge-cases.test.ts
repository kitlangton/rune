/**
 * Edge-case fidelity for the expanded surface.
 *
 * The expanded string/array/switch/Object/Math/coercion surface should behave like
 * JavaScript at the boundaries agents actually hit: negative indices, misses, empty
 * inputs, fall-through, default placement, lexicographic vs numeric sort, etc.
 * Each `expectValue` here uses the value JavaScript itself produces.
 *
 * The one DELIBERATE divergence — `sort`/`reverse` are non-mutating in Rune — is
 * pinned explicitly at the bottom so it can't regress silently in either direction.
 */
import { describe, expect, test } from "bun:test"
import { expectFailure, expectValue, run } from "./test-harness.ts"

describe("string edge cases match JavaScript", () => {
  test("negative and out-of-range indices", async () => {
    await expectValue(`return "hello".slice(-3)`, "llo")
    await expectValue(`return "hello".slice(-3, -1)`, "ll")
    await expectValue(`return "hello".at(-1)`, "o")
    await expectValue(`return "hi".charAt(9)`, "")
    await expectValue(`return "hi".indexOf("z")`, -1)
  })

  test("empty / no-op transforms", async () => {
    await expectValue(`return "abc".split("")`, ["a", "b", "c"])
    await expectValue(`return "x".repeat(0)`, "")
    await expectValue(`return "abc".replace("z", "Q")`, "abc")
  })

  test("multi-character padding truncates like JavaScript", () =>
    expectValue(`return "7".padStart(5, "ab")`, "abab7"))
})

describe("array edge cases match JavaScript", () => {
  test("negative slice / at", async () => {
    await expectValue(`return [1, 2, 3, 4, 5].slice(-2)`, [4, 5])
    await expectValue(`return [1, 2, 3].at(-2)`, 2)
  })

  test("concat mixes scalars and arrays; flat respects depth", async () => {
    await expectValue(`return [1].concat(2, [3, 4])`, [1, 2, 3, 4])
    await expectValue(`return [1, [2, [3, [4]]]].flat(99)`, [1, 2, 3, 4])
  })

  test("misses and single-element reduce", async () => {
    await expectValue(`return [1, 2, 3].findIndex((x) => x > 9)`, -1)
    await expectValue(`return [42].reduce((a, b) => a + b)`, 42)
  })

  test("default sort is lexicographic; comparator sort is numeric and stable", async () => {
    await expectValue(`return [10, 9, 100, 1].sort()`, [1, 10, 100, 9])
    await expectValue(`return [3, 1, 2].sort((a, b) => a - b)`, [1, 2, 3])
    await expectValue(
      `return [{ k: 1, v: "a" }, { k: 1, v: "b" }, { k: 0, v: "c" }].sort((a, b) => a.k - b.k).map((o) => o.v)`,
      ["c", "a", "b"],
    )
  })
})

describe("switch matches JavaScript semantics", () => {
  test("fall-through until break", () =>
    expectValue(
      `let r = []
       switch (2) { case 1: r = [...r, 1]; case 2: r = [...r, 2]; case 3: r = [...r, 3]; break; case 4: r = [...r, 4] }
       return r`,
      [2, 3],
    ))

  test("default can sit between cases", () =>
    expectValue(
      `let r = "x"
       switch (9) { case 1: r = "one"; break; default: r = "def"; break; case 2: r = "two" }
       return r`,
      "def",
    ))

  test("no match and no default falls through to nothing", () =>
    expectValue(`let r = "none"\nswitch (9) { case 1: r = "one" }\nreturn r`, "none"))

  test("string discriminant + return from a case", () =>
    expectValue(
      `const f = (n) => { switch (n) { case 1: return "one"; default: return "other" } }
       return f(1) + f(5)`,
      "oneother",
    ))
})

describe("Object / Math / coercion edge cases match JavaScript", () => {
  test("Object.entries preserves insertion order; fromEntries lets the last key win", async () => {
    await expectValue(`return Object.entries({ b: 2, a: 1, c: 3 })`, [["b", 2], ["a", 1], ["c", 3]])
    await expectValue(`return Object.fromEntries([["a", 1], ["a", 2]])`, { a: 2 })
  })

  test("Math rounding and truncation", async () => {
    await expectValue(`return [Math.round(2.5), Math.round(-2.5), Math.round(0.5)]`, [3, -2, 1])
    await expectValue(`return Math.trunc(-4.7)`, -4)
  })

  test("Number / String / Boolean coercion", async () => {
    await expectValue(`return Number("")`, 0)
    await expectValue(`return Number("  12  ")`, 12)
    await expectValue(`return String([1, [2, 3], 4])`, "1,2,3,4")
    await expectValue(`return [Boolean(0), Boolean(""), Boolean(" "), Boolean("0")]`, [false, false, true, true])
  })
})

describe("deliberate divergence: sort and reverse do not mutate", () => {
  // JavaScript mutates in place and returns the same reference. Rune returns a fresh
  // array and leaves the source untouched — safer for a confined, data-only language.
  test("reverse returns a copy; the source is unchanged", () =>
    expectValue(`const a = [1, 2, 3]\nconst b = a.reverse()\nreturn [a[0], b[0]]`, [1, 3]))

  test("sort returns a copy; the source is unchanged", () =>
    expectValue(`const a = [3, 1, 2]\nconst b = a.sort((x, y) => x - y)\nreturn [a[0], b[0]]`, [3, 1]))

  test("the source array keeps its original order after sort", async () => {
    const result = await run(`const a = [3, 1, 2]\na.sort((x, y) => x - y)\nreturn a`)
    expect(result.ok && result.value).toEqual([3, 1, 2])
  })
})

describe("Math constants", () => {
  test("PI and E are available", async () => {
    await expectValue(`return Math.round(Math.PI * 100) / 100`, 3.14)
    await expectValue(`return Math.round(Math.E * 100) / 100`, 2.72)
    await expectValue(`return Math.SQRT2 > 1.41 && Math.SQRT2 < 1.42`, true)
  })

  test("a non-constant Math member is still a method, not a value", () =>
    expectFailure(`return Math.PI()`, { message: /not a function|callable|not available/i }))
})

describe("Array statics", () => {
  test("Array.isArray distinguishes arrays from other values", () =>
    expectValue(`return [Array.isArray([1, 2]), Array.isArray("no"), Array.isArray({})]`, [true, false, false]))

  test("Array.from copies arrays and splits strings", async () => {
    await expectValue(`return Array.from("abc")`, ["a", "b", "c"])
    await expectValue(`return Array.from([1, 2, 3])`, [1, 2, 3])
  })

  test("Array.of builds from its arguments", () => expectValue(`return Array.of(1, 2, 3)`, [1, 2, 3]))

  test("Array.from rejects the map-function form with a retryable hint", () =>
    expectFailure(`return Array.from([1, 2], (x) => x * 2)`, { kind: "UnsupportedSyntax" }))
})

describe("parseInt / parseFloat", () => {
  test("parse numbers from strings", async () => {
    await expectValue(`return parseInt("42")`, 42)
    await expectValue(`return parseInt("ff", 16)`, 255)
    await expectValue(`return parseInt("42px")`, 42)
    await expectValue(`return parseFloat("3.14")`, 3.14)
    await expectValue(`return parseFloat("  2.5kg")`, 2.5)
  })

  test("a capability reference cannot be parsed (confinement holds)", () =>
    expectFailure(`return parseInt(tools.secret)`, { kind: "InvalidDataValue" }))
})
