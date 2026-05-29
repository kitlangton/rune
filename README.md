# Rune

**Give an agent one code tool instead of your entire tool catalog.**

Rune executes a small, confined TypeScript-shaped language over your tools. The model writes familiar code to call capabilities, filter data, recover from failures, and return only the result it needs.

```bash
bun add github:kitlangton/rune
```

## Happy Path

Your application has real capabilities, such as listing GitHub issues and posting to Slack:

```ts
import { Effect, Schema } from "effect"
import { Rune } from "rune"
import { Tool } from "rune/tool"

const Issue = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  priority: Schema.Number,
})

const listIssues = Tool.make({
  description: "List open GitHub issues",
  input: Schema.Struct({ state: Schema.String }),
  output: Schema.Array(Issue),
  run: ({ state }) => Effect.promise(() => github.issues.list({ state })),
})

const postMessage = Tool.make({
  description: "Post a message to Slack",
  input: Schema.Struct({ channel: Schema.String, text: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  run: ({ channel, text }) => Effect.promise(() => slack.chat.postMessage({ channel, text })),
})

const rune = Rune.make({
  tools: {
    github: { issues: { list: listIssues } },
    slack: { chat: { postMessage } },
  },
})
```

## Vercel AI SDK

Expose **one tool** to the model:

```bash
bun add ai
```

```ts
import { generateText, stepCountIs } from "ai"
import { RuneAiSdk } from "rune/ai-sdk"

const result = await generateText({
  model,
  tools: { code: RuneAiSdk.make(rune) },
  stopWhen: stepCountIs(5),
  prompt: "Find high-priority open GitHub issues and send a summary to #eng-alerts.",
})
```

The model sees `code`, not `github.issues.list` or `slack.chat.postMessage` directly. The `code` tool description is derived from the schemas and tells the model:

```ts
// Available Tool Capabilities:
// - tools.github.issues.list(input: { state: string }): Promise<Array<{ number: number; title: string; priority: number }>> // List open GitHub issues
// - tools.slack.chat.postMessage(input: { channel: string; text: string }): Promise<{ ok: boolean }> // Post a message to Slack
```

Given this request:

```txt
Find high-priority open GitHub issues and send a summary to #eng-alerts.
```

The model calls the single `code` tool with a Rune Program:

```ts
const issues = await tools.github.issues.list({ state: "open" })

const urgent = issues
  .filter((issue) => issue.priority >= 3)
  .map((issue) => `#${issue.number} ${issue.title}`)

await tools.slack.chat.postMessage({
  channel: "#eng-alerts",
  text: urgent.join("\n"),
})

return { sent: urgent.length, issues: urgent }
```

Rune executes it and returns:

```ts
{
  ok: true,
  value: {
    sent: 2,
    issues: ["#41 Fix login redirect", "#57 Restore billing webhook"],
  },
  toolCalls: [
    { name: "github.issues.list", args: [{ state: "open" }] },
    {
      name: "slack.chat.postMessage",
      args: [{ channel: "#eng-alerts", text: "#41 Fix login redirect\n#57 Restore billing webhook" }],
    },
  ],
}
```

The model did one code-tool call. Rune composed two underlying capabilities, retained an audit trail, and returned only the useful summary.

## Effect AI

Rune is Effect-native. Use the Effect AI adapter as the model toolkit:

```ts
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { RuneEffectAi } from "rune/effect-ai"

const code = RuneEffectAi.make(rune)

const response = yield* LanguageModel.generateText({
  prompt: "Find high-priority open GitHub issues and send a summary to #eng-alerts.",
  toolkit: code.toolkit,
}).pipe(Effect.provide(code.layer))
```

Capability implementations remain Effects, so they can use services, tracing, typed failures, and interruption from the caller's runtime.

## Promise Adapter

For ordinary functions and promises, use `RunePromise`. It adapts them onto the same runtime:

```ts
import { Schema } from "effect"
import { RunePromise } from "rune/promise"

const lookup = RunePromise.tool({
  description: "Look up an order",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  run: ({ id }) => db.orders.get(id),
})

const rune = RunePromise.make({ tools: { orders: { get: lookup } } })

const result = await rune.run(`return await tools.orders.get({ id: "order_42" })`)
```

## Custom Adapters

`rune.tool()` is the neutral adapter surface if your agent library is not covered yet:

```ts
const code = rune.tool()

code.name        // "code"
code.description // Rune instructions plus schema-derived capability signatures
code.input       // Effect Schema: { code: string }
code.execute({ code: agentProgram })
```

The repository includes runnable adapters/examples:

```bash
bun add --no-save ai
bun run examples/ai-sdk.ts
bun run examples/effect-ai.ts
```

## Large Tool Catalogs

For a small catalog, `rune.tool()` includes the schema-derived catalog in its description automatically. For a large or dynamic catalog, the agent can discover capabilities from within a Rune Program:

```ts
const { items } = await tools.search({ query: "create calendar event", limit: 5 })
const tool = await tools.describe({ path: items[0].path })
return tool.signature
```

You can also construct your own prompt from structured host-side metadata:

```ts
rune.catalog()
// [{
//   path: "github.issues.list",
//   description: "List open GitHub issues",
//   signature: "tools.github.issues.list(input: { state: string }): Promise<Array<{ number: number; title: string; priority: number }>>"
// }, {
//   path: "slack.chat.postMessage",
//   description: "Post a message to Slack",
//   signature: "tools.slack.chat.postMessage(input: { channel: string; text: string }): Promise<{ ok: boolean }>"
// }]
```

## Agent-Friendly Syntax

Rune implements the common code-mode subset agents tend to write:

```ts
// Transform tool results
const urgent = issues
  .filter((issue) => issue.priority >= 3 && issue.title.toLowerCase().includes("security"))
  .map((issue) => issue.title.trim())

// Summarize keyed data
const summary = Object.entries(counts)
  .map(([status, count]) => `${status}: ${count}`)
  .join("\n")

// Build requests
const request = { ...defaults, limit: 10 }

// Recover from a capability failure
try {
  return await tools.orders.get({ id })
} catch (error) {
  return { retry: true, reason: error.message }
}

// Call independent capabilities concurrently
return Promise.all([tools.a.read({}), tools.b.read({})])
```

Supported today: TypeScript annotations, plain data, destructuring, optional chaining, conditionals, `switch`, loops, arrow callbacks and closures, spread, `try` / `catch` / `finally` / `throw`, common non-mutating array and string transformations, confined `Object` / `Math` / `JSON` helpers, primitive coercions, and constrained `Promise.all(...)`.

Unsupported syntax returns a diagnostic the agent can use to rewrite and retry:

```ts
{
  kind: "UnsupportedSyntax",
  location: { line: 1, column: 1 },
  message: "Syntax 'FunctionDeclaration' is not supported in Rune. ...",
  suggestions: ["Supported orchestration syntax includes tools.* calls, ..."],
}
```

## Permissions And Built-In Capabilities

Rune Programs do not get ambient filesystem, network, environment, or timer access. Add explicit capabilities when needed, and gate sensitive calls per capability:

```ts
import { Clock } from "rune/clock"
import { Fs } from "rune/fs"
import { Http } from "rune/http"
import { Store } from "rune/store"

const rune = Rune.make({
  tools: {
    github,
    fs: Fs.workspace({ root: "./workspace" }),
    http: Http.targets({
      targets: {
        github: {
          origin: "https://api.github.com",
          methods: ["GET"],
          pathPrefixes: ["/repos/kitlangton/"],
        },
      },
    }),
    store: Store.memory({ maxBytes: 1_000_000 }),
    clock: Clock.make({ maxSleepMs: 1_000 }),
  },

  policy: {
    requireApproval: [
      { path: "fs.writeText", reason: "This changes a workspace file" },
      "http.request",
      "store.put",
    ],
  },

  requestApproval: ({ path, input, reason }) =>
    confirm({ title: reason ?? `Allow ${path}?`, details: input }),
})
```

`requestApproval` may return a `boolean` or `Effect<boolean>`:

```ts
requestApproval: ({ path }) => path !== "http.request"
```

The configured packs become ordinary agent-visible tools:

```ts
const readme = await tools.fs.readText({ path: "README.md" })
const cached = await tools.store.get({ key: "summary" })
const now = await tools.clock.now({})
```

Defaults:

- `Fs.readonly(...)` provides read-only mounted file access with bounded streamed file reads.
- `Fs.workspace(...)` adds write/remove operations that require approval unless policy allows them.
- `Store.memory({ maxBytes })` bounds retained session data; mutations require approval unless policy allows them.
- `Http.targets(...)` exposes named HTTPS targets with bounded streamed responses and requires approval unless policy allows requests. Configure injected HTTP transports not to follow redirects invisibly, and validate DNS/network egress at the host boundary when private-network exclusion is required.
- `Clock.make(...)` provides bounded `now` / `sleep` operations without approval.
- No raw environment or secret accessor is provided; keep credentials inside host-backed tools.

## Confinement

Rune Programs receive plain data and explicit `tools.*` capabilities only.

```ts
return [].constructor.constructor("return globalThis")() // rejected
return tools.read.constructor("return globalThis")()     // rejected
return Promise.constructor                                // rejected
```

There are no imports, ambient globals, native prototypes, filesystem calls, network calls, or arbitrary host functions exposed to the program. Limits cover operations, capability calls, retained audit bytes, concurrency, source/data size, nesting depth, collection length, and wall time. Effect timeouts interrupt running capabilities.

Rune is an in-process confined interpreter. A separate process remains useful defense in depth for hostile multi-tenant workloads.

## Development

```bash
bun install
bun run typecheck
bun test
```
