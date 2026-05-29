/**
 * Regression tests for the adversarial-audit findings on the extended language surface.
 * Each pins a confirmed bug (double-eval, limit bypass, confinement leak, JS divergence)
 * that was found by executing PoCs against the runtime and then fixed.
 */
import { describe, expect, test } from "bun:test"
import { expectFailure, expectOk, expectValue, run } from "./test-harness.ts"
import { spy } from "./test-harness.ts"

describe("logical assignment resolves its member target exactly once", () => {
  test("a side-effecting object expression runs once", async () => {
    const get = spy(() => ({ k: undefined }))
    const result = await run(`tools.get().k ??= 1\nreturn tools.count()`, { tools: { get, count: () => get.count } })
    expect(expectOk(result).value).toBe(1)
  })

  test("a computed key is evaluated once and the write lands on the read target", async () => {
    const key = spy((() => {
      let n = 0
      return () => (++n === 1 ? "a" : "b")
    })())
    const result = await run(`const o = { a: undefined, b: undefined }\no[tools.key()] ??= 99\nreturn o`, { tools: { key } })
    expect(expectOk(result).value).toEqual({ a: 99, b: undefined })
    expect(key.count).toBe(1)
  })

  test("the right-hand side is not evaluated when the assignment is skipped", async () => {
    const result = await run(`let x = 1\nx ??= tools.boom()\nreturn x`, {
      tools: { boom: () => { throw new Error("should not run") } },
    })
    expect(expectOk(result).value).toBe(1)
    expect(result.ok && result.toolCalls.length).toBe(0)
  })
})

describe("push/unshift cannot bypass maxCollectionLength via a caught error", () => {
  test("swallowing push errors in a loop never grows past the cap", async () => {
    const result = await run(`let a = []\nfor (let i = 0; i < 30; i = i + 1) { try { a.push(0) } catch (e) {} }\nreturn a.length`, {
      limits: { maxCollectionLength: 5 },
    })
    expect(expectOk(result).value).toBe(5)
  })

  test("unshift is likewise bounded", async () => {
    const result = await run(`let a = [1, 2, 3, 4, 5]\ntry { a.unshift(0) } catch (e) {}\nreturn a.length`, {
      limits: { maxCollectionLength: 5 },
    })
    expect(expectOk(result).value).toBe(5)
  })
})

describe("an uncaught throw of a capability reference cannot leak its internals", () => {
  test.each([
    [`throw tools.secret`, "a thrown tool reference"],
    [`throw () => 1`, "a thrown function"],
    [`throw { wrapped: tools.secret }`, "a tool reference nested in a thrown object"],
  ])("%s is sanitized — %s", async (code) => {
    const result = await run(code, { tools: { secret: () => "s" } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe("Uncaught: a non-data value")
      expect(result.error.message).not.toContain("path")
      expect(result.error.message).not.toContain("body")
    }
  })

  test("a plain thrown object is still serialized for the agent", async () => {
    const result = await run(`throw { code: "INVALID" }`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe(`Uncaught: {"code":"INVALID"}`)
  })
})

describe("array callbacks iterate a stable snapshot", () => {
  test("a callback that pushes to the array does not self-extend the loop", () =>
    expectValue(`const a = [1, 2, 3]\nconst seen = a.map((x) => { a.push(x); return x })\nreturn seen`, [1, 2, 3]))

  test("filter over a self-mutating array stays bounded to the original elements", () =>
    expectValue(`const a = [1, 2, 3, 4]\nreturn a.filter((x) => { if (x === 1) a.push(99); return x % 2 === 0 })`, [2, 4]))
})

describe("the operation budget tracks O(n) work, so maxOperations is a real CPU bound", () => {
  test("a tight loop of O(n) array scans trips the operation limit, not just the timeout", async () => {
    const result = await run(
      `let a = []
       for (let i = 0; i < 2000; i = i + 1) { a.push(i) }
       let c = 0
       for (let i = 0; i < 100000; i = i + 1) { if (a.includes(-1)) c = c + 1 }
       return c`,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("OperationLimitExceeded")
  })

  test("O(n^2) spread accumulation is bounded by the operation budget", async () => {
    const result = await run(`let a = []\nfor (let i = 0; i < 100000; i = i + 1) { a = [...a, i] }\nreturn a.length`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("OperationLimitExceeded")
  })

  test("legitimate push accumulation is O(1) per element and stays well under the budget", () =>
    expectValue(`let a = []\nfor (let i = 0; i < 5000; i = i + 1) { a.push(i) }\nreturn a.length`, 5000))

  test("a single transform over a medium collection still succeeds", () =>
    expectValue(`let a = []\nfor (let i = 0; i < 1000; i = i + 1) { a.push(i) }\nreturn a.map((x) => x * 2).length`, 1000))
})

describe("JS-divergence fixes", () => {
  test("`in` on arrays does not leak Array.prototype", () =>
    expectValue(`return ["map" in [1], "constructor" in [1], "length" in [1], 0 in [1]]`, [false, false, true, true]))

  test("Array.with() defaults a missing index to 0", () => expectValue(`return [1, 2, 3].with(undefined, 9)`, [9, 2, 3]))

  test("new Error(undefined) yields an empty message", () =>
    expectValue(`try { throw new Error(undefined) } catch (e) { return e.message }`, ""))
})
