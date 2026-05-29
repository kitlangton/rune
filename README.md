# Rune

**Give an agent one code tool instead of your entire tool catalog.**

Rune executes a small, confined TypeScript-shaped language over your tools. The model writes familiar code to call capabilities, filter data, recover from failures, and return only the result it needs.

```bash
bun add @kitlangton/rune effect
```

## Happy Path

Your application has real capabilities, such as listing GitHub issues and posting to Slack:

```ts
import { Effect, Schema } from "effect"
import { Rune, Tool } from "@kitlangton/rune"

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
import { RuneAiSdk } from "@kitlangton/rune/ai-sdk"

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

The model did one code-tool call. Rune composed two underlying capabilities, retained an audit trail of executed capabilities, and returned only the useful summary. Requests rejected by policy, approval, or input validation do not appear as executed `toolCalls`.

## Effect AI

Rune is Effect-native. Use the Effect AI adapter as the model toolkit:

```ts
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { RuneEffectAi } from "@kitlangton/rune/effect-ai"

const code = RuneEffectAi.make(rune)

const response = Effect.gen(function*() {
  return yield* LanguageModel.generateText({
    prompt: "Find high-priority open GitHub issues and send a summary to #eng-alerts.",
    toolkit: code.toolkit,
  })
}).pipe(Effect.provide(code.layer))
```

Capability implementations remain Effects, so they can use services, tracing, typed failures, and interruption from the caller's runtime.

If the configured Rune requires application services, use `makeWith` to provide them at the adapter boundary:

```ts
const code = RuneEffectAi.makeWith(rune, (effect) => effect.pipe(Effect.provide(appLayer)))
```

## Promise Adapter

For ordinary functions and promises, import `Rune` from the Promise entrypoint. It adapts them onto the same runtime:

```ts
import { Schema } from "effect"
import { Rune, Tool } from "@kitlangton/rune/promise"

const lookup = Tool.make({
  description: "Look up an order",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String, status: Schema.String }),
  run: ({ id }) => db.orders.get(id),
})

const rune = Rune.make({ tools: { orders: { get: lookup } } })

const result = await rune.run(`return await tools.orders.get({ id: "order_42" })`)
```

`RuneAiSdk.make(rune)` accepts a Promise Rune or a service-free Effect Rune. For an Effect Rune that requires services, provide its execution boundary explicitly:

```ts
const code = RuneAiSdk.makeEffect(rune, (effect) => Effect.runPromise(effect.pipe(Effect.provide(appLayer))))
```

## Custom Adapters

`rune.asTool()` is the neutral adapter surface if your agent library is not covered yet:

```ts
const code = rune.asTool()

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

For a small catalog, `rune.asTool()` includes the schema-derived catalog in its description automatically. For a large or dynamic catalog, the agent can discover capabilities from within a Rune Program:

```ts
const { items } = await tools.$rune.search({ query: "create calendar event", limit: 5 })
const tool = await tools.$rune.describe({ path: items[0].path })
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

Supported today: TypeScript annotations, plain data, destructuring (with rest/defaults), optional chaining, conditionals, `switch`, loops, arrow functions and `function` declarations (hoisted) with closures, default/rest parameters, spread, `try` / `catch` / `finally` / `throw` (including `new Error(...)`), common non-mutating array and string transformations, confined `Object` / `Math` / `JSON` helpers, primitive coercions, and constrained `Promise.all(...)`.

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
import { Clock } from "@kitlangton/rune/clock"
import { Fs } from "@kitlangton/rune/fs"
import { Http } from "@kitlangton/rune/http"
import { Store } from "@kitlangton/rune/store"

const rune = Rune.make({
  tools: {
    github,
    fs: Fs.workspace({ root: "./workspace" }),
    http: Http.targets({
      github: {
        origin: "https://api.github.com",
        methods: ["GET"],
        pathPrefixes: ["/repos/kitlangton/"],
      },
    }),
    store: Store.memory({ maxBytes: 1_000_000 }),
    clock: Clock.make({ maxSleepMs: 1_000 }),
  },

  policy: {
    allow: ["github.*", "fs.*", "http.github.get", "store.*", "clock.*", "$rune.*"],
    requireApproval: [
      { path: "fs.writeText", reason: "This changes a workspace file" },
      "http.github.get",
    ],
  },

  requestApproval: ({ path, input, reason }) =>
    confirm({ title: reason ?? `Allow ${path}?`, details: input }),
})
```

`requestApproval` may return a `boolean` or `Effect<boolean>`:

```ts
requestApproval: ({ path }) => path !== "http.github.get"
```

When `allow` is present it is an allowlist: unmatched capabilities are denied. It never bypasses an approval requirement; use `autoApprove` only when a sensitive capability should be explicitly allowed without prompting.

The configured packs become ordinary agent-visible tools:

```ts
const readme = await tools.fs.readText({ path: "README.md" })
const cached = await tools.store.get({ key: "summary" })
const now = await tools.clock.now({})
const issues = await tools.http.github.get({ path: "/repos/kitlangton/rune/issues" })
```

Defaults:

- `Fs.readonly(...)` provides read-only mounted file access with bounded streamed file reads.
- `Fs.workspace(...)` adds write/remove operations that require approval unless policy explicitly uses `autoApprove`. Generic filesystem path APIs cannot eliminate check/use races if another untrusted process can concurrently replace paths inside the mounted root; use only roots with trusted mutation ownership unless your host filesystem implementation enforces no-follow operations atomically.
- `Store.memory({ maxBytes })` is bounded memory scoped to the pack instance, and therefore persists across repeated runs of a shared `Rune`. Construct it per user/session where isolation matters. Set `approval: "required"` if mutations must be approved.
- `Http.targets(...)` exposes each allowed method as its own policy path, such as `tools.http.github.get(...)` or `tools.http.github.post(...)`; requests require approval unless policy explicitly uses `autoApprove`. Only auto-approve specifically safe method leaves. Configure injected HTTP transports not to follow redirects invisibly, and validate DNS/network egress at the host boundary when private-network exclusion is required.
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

Configure tighter limits for the authority and latency budget of each code tool:

```ts
const rune = Rune.make({
  tools,
  limits: { maxToolCalls: 20, maxConcurrency: 4, timeoutMs: 5_000 },
})
```

Defaults are `maxToolCalls: 100`, `maxConcurrency: 8`, `timeoutMs: 10_000`, `maxSourceBytes: 32_000`, `maxDataBytes: 256_000`, `maxAuditBytes: 1_000_000`, `maxValueDepth: 32`, `maxCollectionLength: 10_000`, and `maxOperations: 100_000`.

Rune is an in-process confined interpreter. A separate process remains useful defense in depth for hostile multi-tenant workloads.

## Development

```bash
bun install
bun run typecheck
bun test
```

## Releases

Rune uses Changesets for package releases after the initial `0.1.0` publication:

```bash
bun run changeset          # record a user-facing change
bun run version-packages   # apply pending version/changelog updates
bun run release            # validate and publish to npm
```

`bun run release` publishes `@kitlangton/rune` and may require npm browser/OTP authorization from the authenticated maintainer account.
