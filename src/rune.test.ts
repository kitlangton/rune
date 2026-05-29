import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Rune, type ExecuteResult, type ExecutionLimits, type ToolCall } from "./rune.ts"
import { Rune as PromiseRune, Tool as PromiseTool } from "./promise.ts"
import { Tool } from "./tool.ts"

type TestTools = { readonly [name: string]: ((...args: Array<unknown>) => unknown | PromiseLike<unknown>) | TestTools }

const runExecute = (options: { readonly code: string; readonly tools?: TestTools; readonly limits?: ExecutionLimits }) =>
  PromiseRune.execute(options as never)

const expectOk = (
  result: ExecuteResult,
): {
  ok: true
  value: unknown
  toolCalls: ReadonlyArray<ToolCall>
} => {
  expect(result.ok).toBe(true)

  if (!result.ok) {
    throw new Error(result.error.message)
  }

  return result
}

describe("Rune from promise entrypoint execute", () => {
  test("runs tool-calling + arithmetic script", async () => {
    const result = await runExecute({
      code: `
        const sum = tools.add(2, 3)
        tools.log("sum", sum)
        return sum * 10
      `,
      tools: {
        add: (a, b) => Number(a) + Number(b),
        log: () => undefined,
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(50)
    expect(okResult.toolCalls).toEqual([
      { name: "add", args: [2, 3] },
      { name: "log", args: ["sum", 5] },
    ])
  })

  test("supports variable assignment and if blocks", async () => {
    const result = await runExecute({
      code: `
        let value = 2
        if (value < 5) {
          value += 3
        }
        return value * 2
      `,
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(10)
  })

  test("supports object and array literals for tool args", async () => {
    const result = await runExecute({
      code: `
        const payload = { id: "a", values: [1, 2, 3] }
        tools.capture(payload)
        return payload.values[1]
      `,
      tools: {
        capture: () => undefined,
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(2)
    expect(okResult.toolCalls).toEqual([
      {
        name: "capture",
        args: [{ id: "a", values: [1, 2, 3] }],
      },
    ])
  })

  test("does not expose ambient host capabilities", async () => {
    const result = await runExecute({
      code: `return console`,
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected ambient capability lookup to fail")
    }

    expect(result.error.message).toContain("Unknown identifier 'console'")
  })

  test("supports explicit await", async () => {
    const result = await runExecute({
      code: `
        const sum = await tools.addAsync(10, 15)
        return sum * 2
      `,
      tools: {
        addAsync: async (a: unknown, b: unknown) => Number(a) + Number(b),
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(50)
    expect(okResult.toolCalls).toEqual([{ name: "addAsync", args: [10, 15] }])
  })

  test("accepts TypeScript snippets and records namespaced tool calls", async () => {
    const result = await runExecute({
      code: `
        type Amount = number
        const amount: Amount = await tools.orders.total("pending") as number
        return amount satisfies number
      `,
      tools: {
        orders: {
          total: async () => 42,
        },
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(42)
    expect(okResult.toolCalls).toEqual([{ name: "orders.total", args: ["pending"] }])
  })

  test("supports destructuring and optional chaining for tool discovery", async () => {
    const result = await runExecute({
      code: `
        type Match = { path: string }
        const { items } = await tools.query({ query: "github issues" }) as { items: Array<Match> }
        const path = items[0]?.path
        return path ?? "missing"
      `,
      tools: {
        query: () => ({ items: [{ path: "github.issues.list" }] }),
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe("github.issues.list")
    expect(okResult.toolCalls).toEqual([{ name: "query", args: [{ query: "github issues" }] }])
  })

  test("supports sync-looking tool calls with async tool implementations", async () => {
    const result = await runExecute({
      code: `
        const a = tools.getNumber(2)
        const b = tools.getNumber(3)
        return a + b
      `,
      tools: {
        getNumber: async (value: unknown) => Number(value),
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(5)
    expect(okResult.toolCalls).toEqual([
      { name: "getNumber", args: [2] },
      { name: "getNumber", args: [3] },
    ])
  })

  test("handles multiple tools and preserves call order", async () => {
    const result = await runExecute({
      code: `
        const base = tools.fetchBase(5)
        const next = tools.add(base, 7)
        tools.audit("next", next)
        return tools.finalize(next)
      `,
      tools: {
        fetchBase: async (n: unknown) => Number(n) * 2,
        add: (a: unknown, b: unknown) => Number(a) + Number(b),
        audit: () => undefined,
        finalize: async (n: unknown) => `done:${n}`,
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe("done:17")
    expect(okResult.toolCalls).toEqual([
      { name: "fetchBase", args: [5] },
      { name: "add", args: [10, 7] },
      { name: "audit", args: ["next", 17] },
      { name: "finalize", args: [17] },
    ])
  })

  test("supports while loops, break, and continue", async () => {
    const result = await runExecute({
      code: `
        let i = 0
        let sum = 0

        while (i < 10) {
          i += 1

          if (i === 2) {
            continue
          }

          if (i === 7) {
            break
          }

          sum += i
          tools.step(i, sum)
        }

        return sum
      `,
      tools: {
        step: () => undefined,
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(19)
    expect(okResult.toolCalls).toEqual([
      { name: "step", args: [1, 1] },
      { name: "step", args: [3, 4] },
      { name: "step", args: [4, 8] },
      { name: "step", args: [5, 13] },
      { name: "step", args: [6, 19] },
    ])
  })

  test("supports for loops and update expressions", async () => {
    const result = await runExecute({
      code: `
        let total = 0

        for (let i = 1; i <= 4; i += 1) {
          total += i
        }

        let counter = 0
        counter++
        ++counter

        return total * counter
      `,
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(20)
  })

  test("supports do-while loops and async tools inside loops", async () => {
    const result = await runExecute({
      code: `
        let i = 0
        let acc = 1

        do {
          i += 1
          acc = tools.mul(acc, i)
        } while (i < 4)

        return acc
      `,
      tools: {
        mul: async (a: unknown, b: unknown) => Number(a) * Number(b),
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(24)
    expect(okResult.toolCalls).toEqual([
      { name: "mul", args: [1, 1] },
      { name: "mul", args: [1, 2] },
      { name: "mul", args: [2, 3] },
      { name: "mul", args: [6, 4] },
    ])
  })

  test("supports for-of aggregation over tool results", async () => {
    const result = await runExecute({
      code: `
        type Row = { value: number }
        const rows = tools.rows.list() as Array<Row>
        let total = 0
        for (const { value } of rows) {
          total += value
        }
        return total
      `,
      tools: {
        rows: {
          list: () => [{ value: 2 }, { value: 3 }, { value: 5 }],
        },
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toBe(10)
    expect(okResult.toolCalls).toEqual([{ name: "rows.list", args: [] }])
  })

  test("supports arrow callbacks with safe collection operations", async () => {
    const result = await runExecute({
      code: `
        const rows = tools.rows.list()
        const minimum = 3
        const values = rows.filter((row) => row.value >= minimum).map((row) => row.value)
        const found = rows.find((row) => row.value === 3)
        return {
          values,
          found: found?.value ?? 0,
          anyLarge: rows.some((row) => row.value > 4),
          allPositive: rows.every((row) => row.value > 0),
          includesFound: values.includes(3),
          joined: values.join(","),
        }
      `,
      tools: { rows: { list: () => [{ value: 2 }, { value: 3 }, { value: 5 }] } },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toEqual({
      values: [3, 5],
      found: 3,
      anyLarge: true,
      allPositive: true,
      includesFound: true,
      joined: "3,5",
    })
  })

  test("runs direct Promise.all Tool Capabilities concurrently", async () => {
    let active = 0
    let maxActive = 0
    const result = await runExecute({
      code: `return Promise.all([tools.load("a"), tools.load("b")])`,
      tools: {
        load: async (value) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          return value
        },
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toEqual(["a", "b"])
    expect(maxActive).toBe(2)
  })

  test("runs Promise.all over mapped Tool Capabilities concurrently", async () => {
    let active = 0
    let maxActive = 0
    const result = await runExecute({
      code: `
        const prefix = "issue-"
        const items = tools.list()
        return Promise.all(items.map((item) => tools.load(prefix + item.id)))
      `,
      tools: {
        list: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
        load: async (id) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          return id
        },
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toEqual(["issue-a", "issue-b", "issue-c"])
    expect(maxActive).toBe(3)
  })

  test("honors configured concurrency limits for parallel capabilities", async () => {
    let active = 0
    let maxActive = 0
    const result = await runExecute({
      code: `return Promise.all([tools.load("a"), tools.load("b"), tools.load("c")])`,
      limits: { maxConcurrency: 1 },
      tools: {
        load: async (value) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 2))
          active -= 1
          return value
        },
      },
    })

    expect(expectOk(result).value).toEqual(["a", "b", "c"])
    expect(maxActive).toBe(1)
  })

  test("explains unsupported Promise.all expressions for agent retries", async () => {
    const result = await runExecute({
      code: `return Promise.all(tools.list())`,
      tools: { list: () => [1, 2] },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected an unsupported Promise.all expression")
    expect(result.error.message).toContain("Promise.all supports direct items.map")
    expect(result.error.message).toContain("Promise.all([tool calls])")
    expect(result.toolCalls).toEqual([])
  })

  test("does not run arbitrary expressions concurrently through Promise.all", async () => {
    const result = await runExecute({
      code: `return Promise.all([tools.load("a"), "not a tool call"])`,
      tools: { load: (value) => value },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected Promise.all restriction")
    expect(result.error.message).toContain("array elements must be direct Tool Capability calls")
    expect(result.toolCalls).toEqual([])
  })

  test("supports object, array, and argument spread for tool requests", async () => {
    const result = await runExecute({
      code: `
        const base = { query: "issues", limit: 5 }
        const args = { ...base, limit: 10 }
        const ids = ["a", ...["b", "c"]]
        return tools.capture(args, ...ids)
      `,
      tools: {
        capture: (args, ...ids) => ({ args, ids }),
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toEqual({ args: { query: "issues", limit: 10 }, ids: ["a", "b", "c"] })
    expect(okResult.toolCalls).toEqual([{ name: "capture", args: [{ query: "issues", limit: 10 }, "a", "b", "c"] }])
  })

  test("supports try, catch, and throw with safe error data", async () => {
    const result = await runExecute({
      code: `
        let rejected = ""
        try {
          tools.failure()
        } catch (error) {
          rejected = error.message
        }

        try {
          throw { code: "missing" }
        } catch (error) {
          return { rejected, code: error.code }
        }
      `,
      tools: {
        failure: () => Promise.reject(new Error("not available")),
      },
    })

    const okResult = expectOk(result)
    expect(okResult.value).toEqual({ rejected: "not available", code: "missing" })
  })

  test("runs finally after recovered orchestration failures", async () => {
    const result = await runExecute({
      code: `
        let cleanedUp = false
        let message = ""
        try {
          throw "failed"
        } catch (error) {
          message = error
        } finally {
          cleanedUp = true
        }
        return { message, cleanedUp }
      `,
    })

    const okResult = expectOk(result)
    expect(okResult.value).toEqual({ message: "failed", cleanedUp: true })
  })

  test("returns clear error for unsupported syntax", async () => {
    const result = await runExecute({
      code: `class Unsupported {}`,
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected failure for unsupported ClassDeclaration")
    }

    expect(result.error.message).toContain("Syntax 'ClassDeclaration' is not supported in Rune")
    expect(result.error.message).toContain("Supported orchestration syntax")
    expect(result.error.kind).toBe("UnsupportedSyntax")
    expect(result.error.location).toEqual({ line: 1, column: 1 })
  })

  test("returns clear error for unknown identifiers", async () => {
    const result = await runExecute({
      code: `
        return notDefined + 1
      `,
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected failure for unknown identifier")
    }

    expect(result.error.message).toContain("Unknown identifier 'notDefined'")
  })

  test("does not expose prototype constructors from data values", async () => {
    const result = await runExecute({
      code: `return [].constructor.constructor("return globalThis")()`,
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected prototype access to fail")
    }

    expect(result.error.message).toContain("Property 'constructor' is not available in Rune")
  })

  test("does not expose native functions from tool capabilities", async () => {
    const result = await runExecute({
      code: `return tools.read.constructor("return globalThis")()`,
      tools: { read: () => "secret" },
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected tool capability escape to fail")
    }

    expect(result.error.message).toContain("Tool paths must use safe string property names")
  })

  test("does not expose native Promise capabilities", async () => {
    const result = await runExecute({ code: `return Promise.constructor` })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected Promise escape to fail")
    expect(result.error.message).toContain("Promise.constructor is not available in Rune")
  })

  test("rejects non-data tool results at the capability boundary", async () => {
    const result = await runExecute({
      code: `return tools.unsafe()`,
      tools: { unsafe: () => new Date() },
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected native object result to fail")
    }

    expect(result.error.message).toContain("must contain plain objects only")
  })

  test("stops runaway scripts at their operation budget", async () => {
    const result = await runExecute({
      code: `while (true) {}`,
      limits: { maxOperations: 20 },
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected failure for operation limit")
    }

    expect(result.error.message).toContain("operation limit of 20")
    expect(result.error.kind).toBe("OperationLimitExceeded")
  })

  test("rejects oversized sources and deep data with structured diagnostics", async () => {
    const source = await runExecute({ code: `return "long"`, limits: { maxSourceBytes: 4 } })
    expect(source.ok).toBe(false)
    if (source.ok) throw new Error("Expected source-size diagnostic")
    expect(source.error.kind).toBe("InvalidDataValue")

    const value = await runExecute({
      code: `return tools.deep()`,
      limits: { maxValueDepth: 1 },
      tools: { deep: () => ({ outer: { inner: true } }) },
    })
    expect(value.ok).toBe(false)
    if (value.ok) throw new Error("Expected depth diagnostic")
    expect(value.error.kind).toBe("InvalidDataValue")
  })

  test("stops scripts that exceed their tool-call budget", async () => {
    const result = await runExecute({
      code: `
        tools.log(1)
        tools.log(2)
      `,
      tools: { log: () => undefined },
      limits: { maxToolCalls: 1 },
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected failure for tool-call limit")
    }

    expect(result.error.message).toContain("tool-call limit of 1")
    expect(result.toolCalls).toEqual([{ name: "log", args: [1] }])
  })

  test("bounds retained tool-call audit arguments cumulatively", async () => {
    const result = await runExecute({
      code: `tools.log("1234567890"); tools.log("1234567890"); return null`,
      tools: { log: () => undefined },
      limits: { maxAuditBytes: 55 },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected failure for audit limit")
    expect(result.error.kind).toBe("AuditLimitExceeded")
    expect(result.toolCalls).toEqual([{ name: "log", args: ["1234567890"] }])
  })

  test("charges capability names against the retained audit budget", async () => {
    const result = await runExecute({
      code: `return tools.veryLongCapabilityName()` ,
      tools: { veryLongCapabilityName: () => null },
      limits: { maxAuditBytes: 5 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected failure for audit limit")
    expect(result.error.kind).toBe("AuditLimitExceeded")
    expect(result.toolCalls).toEqual([])
  })

  test("times out a stalled async tool call", async () => {
    const result = await runExecute({
      code: `return tools.wait()`,
      tools: {
        wait: () => new Promise((resolve) => setTimeout(resolve, 50)),
      },
      limits: { timeoutMs: 1 },
    })

    expect(result.ok).toBe(false)

    if (result.ok) {
      throw new Error("Expected failure for timeout")
    }

    expect(result.error.message).toContain("timed out after 1ms")
  })
})

describe("Rune from promise entrypoint make", () => {
  test("binds capabilities for repeated code-mode runs", async () => {
    const rune = PromiseRune.make({
      tools: {
        account: {
          lookup: PromiseTool.make({
            description: "Look up an account",
            input: Schema.String,
            output: Schema.Struct({ id: Schema.String, active: Schema.Boolean }),
            run: (id) => ({ id, active: true }),
          }),
        },
      },
    })

    const result = await rune.run(`
      const user = tools.account.lookup("u_123")
      return user.active
    `)

    const okResult = expectOk(result)
    expect(okResult.value).toBe(true)
    expect(okResult.toolCalls).toEqual([{ name: "account.lookup", args: ["u_123"] }])
  })

  test("adapts described Promise tools into discovery and execution", async () => {
    const issue = PromiseTool.make({
      description: "Get an issue",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String }),
      run: async ({ id }) => ({ id }),
    })
    const result = await PromiseRune.make({ tools: { issue } }).run(`
      const { items } = tools.$rune.search({ query: "issue" })
      return tools.issue({ id: items[0].path })
    `)

    expect(expectOk(result).value).toEqual({ id: "issue" })
  })
})

describe("Rune.make", () => {
  test("runs Effect tools through the native execution runtime", async () => {
    const rune = Rune.make({
      tools: {
        values: {
          double: Tool.make({
            description: "Double a number",
            input: Schema.Number,
            output: Schema.Number,
            run: (value) => Effect.succeed(value * 2),
          }),
        },
      },
    })
    const result = await Effect.runPromise(
      rune.run(`return tools.values.double(21)`),
    )

    const okResult = expectOk(result)
    expect(okResult.value).toBe(42)
  })

  test("interrupts an Effect tool when the Rune timeout expires", async () => {
    const result = await Effect.runPromise(
      Rune.make({
        tools: { wait: Tool.make({ description: "Wait", input: Schema.Struct({}), output: Schema.Unknown, run: () => Effect.sleep("1 second") }) },
        limits: { timeoutMs: 1 },
      }).run(`return tools.wait({})`),
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected timeout")
    expect(result.error.message).toContain("timed out after 1ms")
  })

  test("lets Rune Programs recover from typed Effect tool failures", async () => {
    const result = await Effect.runPromise(
      Rune.make({
        tools: { lookup: Tool.make({ description: "Look up", input: Schema.Struct({}), output: Schema.Unknown, run: () => Effect.fail("missing record") }) },
      }).run(`
        try {
          return tools.lookup({})
        } catch (error) {
          return error.message
        }
      `),
    )

    const okResult = expectOk(result)
    expect(okResult.value).toBe("missing record")
  })

  test("supports described schema-validated tools through search and describe", async () => {
    const getIssue = Tool.make({
      description: "Get a GitHub issue by id",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String, title: Schema.String }),
      run: (input) => Effect.succeed({ id: input.id, title: `Issue ${input.id}` }),
    })

    const result = await Effect.runPromise(
      Rune.make({ tools: { github: { issues: { get: getIssue } } } }).run(`
        const { items } = tools.$rune.search({ query: "github issue" })
        const details = tools.$rune.describe({ path: items[0].path })
        const issue = tools.github.issues.get({ id: "42" })
        return { path: details.path, signature: details.signature, title: issue.title }
      `),
    )

    const okResult = expectOk(result)
    expect(okResult.value).toEqual({ path: "github.issues.get", signature: `tools.github.issues.get(input: { id: string }): Promise<{ id: string; title: string }>`, title: "Issue 42" })
    expect(okResult.toolCalls.map((call) => call.name)).toEqual(["$rune.search", "$rune.describe", "github.issues.get"])
  })

  test("generates prompt instructions from described tool schemas", () => {
    const issue = Tool.make({
      description: "Get a GitHub issue by id",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String, title: Schema.String }),
      run: ({ id }) => Effect.succeed({ id, title: `Issue ${id}` }),
    })

    const instructions = Rune.make({ tools: { github: { issues: { get: issue } } } }).instructions()
    expect(instructions).toContain("tools.github.issues.get(input: { id: string }): Promise<{ id: string; title: string }>")
    expect(instructions).toContain("Get a GitHub issue by id")
    expect(instructions).toContain("tools.$rune.search")
  })

  test("exposes a structured host-side catalog for custom prompts", () => {
    const issue = Tool.make({
      description: "Get an issue",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ title: Schema.String }),
      run: () => Effect.succeed({ title: "Issue" }),
    })

    expect(Rune.make({ tools: { issue } }).catalog()).toEqual([{
      path: "issue",
      description: "Get an issue",
      signature: "tools.issue(input: { id: string }): Promise<{ title: string }>",
    }])
  })

  test("exposes a single Effect-native code tool for an agent", async () => {
    const issue = Tool.make({
      description: "Get an issue",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String }),
      run: ({ id }) => Effect.succeed({ id }),
    })
    const codeTool = Rune.make({ tools: { issue } }).asTool()

    expect(codeTool.name).toBe("code")
    expect(Schema.decodeUnknownSync(codeTool.input)({ code: "return 1" })).toEqual({ code: "return 1" })
    expect(codeTool.description).toContain("tools.issue")
    const result = await Effect.runPromise(codeTool.execute({ code: `return tools.issue({ id: "42" })` }))
    expect(expectOk(result).value).toEqual({ id: "42" })
  })

  test("reports invalid described tool inputs and outputs", async () => {
    const invalidOutput = Tool.make({
      description: "Broken lookup",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ value: Schema.Number }),
      run: () => Effect.succeed(JSON.parse(`{"value":"not-number"}`)),
    })

    const invalidInput = await Effect.runPromise(
      Rune.make({ tools: { broken: invalidOutput } }).run(`return tools.broken({ id: 1 })`),
    )
    expect(invalidInput.ok).toBe(false)
    if (invalidInput.ok) throw new Error("Expected invalid input")
    expect(invalidInput.error.kind).toBe("InvalidToolInput")

    const invalidResult = await Effect.runPromise(
      Rune.make({ tools: { broken: invalidOutput } }).run(`return tools.broken({ id: "a" })`),
    )
    expect(invalidResult.ok).toBe(false)
    if (invalidResult.ok) throw new Error("Expected invalid output")
    expect(invalidResult.error.kind).toBe("InvalidToolOutput")
  })
})
