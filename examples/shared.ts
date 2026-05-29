import { Effect, Schema } from "effect"
import { Rune } from "../src/rune.ts"
import { Tool } from "../src/tool.ts"

const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  priority: Schema.Number,
})

const ListIssues = Tool.make({
  description: "List open GitHub issues",
  input: Schema.Struct({ state: Schema.String }),
  output: Schema.Array(Issue),
  run: () => Effect.succeed([
    { number: 41, title: "Fix login redirect", priority: 4 },
    { number: 57, title: "Restore billing webhook", priority: 3 },
    { number: 62, title: "Update issue labels", priority: 1 },
  ]),
})

const PostMessage = Tool.make({
  description: "Post a message to Slack",
  input: Schema.Struct({ channel: Schema.String, text: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  run: () => Effect.succeed({ ok: true }),
})

export const rune = Rune.make({
  tools: {
    github: { issues: { list: ListIssues } },
    slack: { chat: { postMessage: PostMessage } },
  },
})

export const agentCode = `
  const issues = await tools.github.issues.list({ state: "open" })
  const urgent = issues
    .filter((issue) => issue.priority >= 3)
    .map((issue) => \`#\${issue.number} \${issue.title}\`)

  await tools.slack.chat.postMessage({
    channel: "#eng-alerts",
    text: urgent.join("\\n"),
  })

  return { sent: urgent.length, issues: urgent }
`
