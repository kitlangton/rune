import { Schema } from "effect"
import { Rune, Tool } from "./promise.ts"

const rune = Rune.make({
  tools: {
    math: {
      add: Tool.make({
        description: "Add two numbers",
        input: Schema.Struct({ left: Schema.Number, right: Schema.Number }),
        output: Schema.Number,
        run: ({ left, right }) => left + right,
      }),
    },
    audit: {
      log: Tool.make({
        description: "Record an audit message",
        input: Schema.Struct({ label: Schema.String, value: Schema.Unknown }),
        output: Schema.Struct({ recorded: Schema.Boolean }),
        run: ({ label, value }) => {
          console.log("[tool.audit.log]", label, value)
          return { recorded: true }
        },
      }),
    },
  },
})

const result = await rune.run(`
  type Result = number
  const value: Result = tools.math.add({ left: 2, right: 3 }) as number
  tools.audit.log({ label: "computed", value })
  return value * 10
`)

if (result.ok) {
  console.log("value:", result.value)
  console.log("toolCalls:", result.toolCalls)
} else {
  console.error("execution failed:", result.error)
}
