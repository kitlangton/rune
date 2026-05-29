import { RunePromise } from "./promise.ts"

const rune = RunePromise.make({
  tools: {
    math: {
      add: (a: unknown, b: unknown) => Number(a) + Number(b),
    },
    audit: {
      log: (...args: Array<unknown>) => {
        console.log("[tool.audit.log]", ...args)
      },
    },
  },
})

const result = await rune.run(`
  type Result = number
  const value: Result = tools.math.add(2, 3) as number
  tools.audit.log("computed", value)
  return value * 10
`)

if (result.ok) {
  console.log("value:", result.value)
  console.log("toolCalls:", result.toolCalls)
} else {
  console.error("execution failed:", result.error)
}
