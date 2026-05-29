import { useRef, useState, type ReactNode, type UIEvent } from "react"
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m, useReducedMotion } from "motion/react"
import { Effect, Schema } from "effect"
import { Rune, type ExecuteResult } from "../../src/rune.ts"
import { Tool } from "../../src/tool.ts"
import { catalog, type HostTools } from "../../src/tool-runtime.ts"

type AuditState = "running" | "succeeded" | "failed"
type RunState = "idle" | "running" | "success" | "failure"

type AuditEntry = {
  readonly id: number
  readonly name: string
  readonly args: unknown
  readonly startedAt: number
  readonly state: AuditState
  readonly durationMs?: number
}

type Scenario = {
  readonly title: string
  readonly code: string
}

type SourceView = {
  readonly lines: ReadonlyArray<string>
  readonly runningLine: number
  readonly completedLine: number
}

const criticalSpring = {
  type: "spring" as const,
  stiffness: 240,
  mass: 1,
  damping: 2 * Math.sqrt(240),
}

const scenarios: ReadonlyArray<Scenario> = [
  {
    title: "Triage",
    code: `const incidents = await tools.operations.incidents({ region: "iad" })
const signals = await Promise.all(
  incidents.map((incident) => tools.telemetry.inspect({ service: incident.service }))
)
const degraded = signals.filter((signal) => signal.status !== "healthy")

return {
  reviewed: signals.length,
  degraded,
}`,
  },
  {
    title: "Mitigate",
    code: `const signals = await Promise.all([
  tools.telemetry.inspect({ service: "edge-gateway" }),
  tools.telemetry.inspect({ service: "image-proxy" }),
])
const degraded = signals.find((signal) => signal.status !== "healthy")

if (degraded) {
  const change = await tools.operations.openChange({
    service: degraded.service,
    reason: "Elevated latency",
  })
  return { degraded, change }
}

return { status: "No action required" }`,
  },
  {
    title: "Discover",
    code: `const found = await tools.search({ query: "telemetry", limit: 2 })
const capability = await tools.describe({ path: found.items[0].path })

return {
  matches: found.total,
  signature: capability.signature,
}`,
  },
]

const Incident = Schema.Struct({
  id: Schema.String,
  service: Schema.String,
  severity: Schema.Number,
  summary: Schema.String,
})

const Signal = Schema.Struct({
  service: Schema.String,
  status: Schema.String,
  latencyMs: Schema.Number,
  errorRate: Schema.Number,
})

const Change = Schema.Struct({
  id: Schema.String,
  service: Schema.String,
  state: Schema.String,
})

const format = (value: unknown): string => JSON.stringify(value, null, 2) ?? "undefined"

const toolSources: Readonly<Record<string, SourceView>> = {
  "operations.incidents": {
    lines: [
      "const incidents = Tool.make({",
      "  input: Schema.Struct({ region: Schema.String }),",
      "  output: Schema.Array(Incident),",
      "  run: ({ region }) => Effect.gen(function* () {",
      "    yield* Effect.sleep(540)",
      "    return activeIncidents(region)",
      "  }),",
      "})",
    ],
    runningLine: 4,
    completedLine: 5,
  },
  "telemetry.inspect": {
    lines: [
      "const inspect = Tool.make({",
      "  input: Schema.Struct({ service: Schema.String }),",
      "  output: Signal,",
      "  run: ({ service }) => Effect.gen(function* () {",
      "    yield* Effect.sleep(service === 'edge-gateway' ? 980 : 680)",
      "    return healthSnapshot(service)",
      "  }),",
      "})",
    ],
    runningLine: 4,
    completedLine: 5,
  },
  "operations.openChange": {
    lines: [
      "const openChange = Tool.make({",
      "  input: Schema.Struct({ service: Schema.String, reason: Schema.String }),",
      "  output: Change,",
      "  run: ({ service, reason }) => Effect.gen(function* () {",
      "    yield* Effect.sleep(720)",
      "    return { id: 'chg-882', service, state: 'awaiting-approval' }",
      "  }),",
      "})",
    ],
    runningLine: 4,
    completedLine: 5,
  },
  search: {
    lines: [
      "// Runtime-provided discovery capability",
      "ToolRuntime.invoke('search', input)",
      "return catalog.filter((tool) => matches(tool, input.query))",
    ],
    runningLine: 1,
    completedLine: 2,
  },
  describe: {
    lines: [
      "// Runtime-provided discovery capability",
      "ToolRuntime.invoke('describe', input)",
      "return catalog.find((tool) => tool.path === input.path)",
    ],
    runningLine: 1,
    completedLine: 2,
  },
}

const syntaxPattern = /(\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|await|return|if|else|true|false|yield)\b|\b(?:tools|Promise|Effect|Tool|Schema|ToolRuntime)\b|\b\d+(?:\.\d+)?\b)/g

const syntax = (line: string): ReactNode => line.split(syntaxPattern).map((part, index) => {
  if (!part) return null
  let kind = ""
  if (part.startsWith("//")) kind = "comment"
  else if (part.startsWith("\"") || part.startsWith("'")) kind = "string"
  else if (/^\d/.test(part)) kind = "number"
  else if (["const", "await", "return", "if", "else", "true", "false", "yield"].includes(part)) kind = "keyword"
  else kind = "symbol"
  return <span className={`token ${kind}`} key={`${index}-${part}`}>{part}</span>
})

function CodeView({ lines, activeLine, completedLine }: {
  readonly lines: ReadonlyArray<string>
  readonly activeLine?: number
  readonly completedLine?: number
}) {
  return (
    <code>
      {lines.map((line, index) => (
        <span
          className={`code-line ${activeLine === index ? "executing" : completedLine === index ? "executed" : ""}`}
          key={`${index}-${line}`}
        >
          <span className="line-number tabular">{String(index + 1).padStart(2, "0")}</span>
          <span className="line-source">{syntax(line)}</span>
        </span>
      ))}
    </code>
  )
}

type DemoRuntime = {
  readonly tools: HostTools
  readonly appendIntrinsicCalls: (result: ExecuteResult) => void
}

const makeRuntime = (publish: (entries: ReadonlyArray<AuditEntry>) => void): DemoRuntime => {
  let entries: Array<AuditEntry> = []
  let nextId = 0

  const invoke = <A,>(name: string, args: unknown, latencyMs: number, produce: () => A): Effect.Effect<A> =>
    Effect.gen(function*() {
      const id = nextId++
      const startedAt = performance.now()
      yield* Effect.sync(() => {
        entries = [...entries, { id, name, args, startedAt, state: "running" }]
        publish(entries)
      })
      yield* Effect.sleep(latencyMs)
      const value = produce()
      yield* Effect.sync(() => {
        entries = entries.map((entry) => entry.id === id
          ? { ...entry, state: "succeeded", durationMs: Math.round(performance.now() - startedAt) }
          : entry)
        publish(entries)
      })
      return value
    })

  const tools: HostTools = {
    operations: {
      incidents: Tool.make({
        description: "List live incidents in a region",
        input: Schema.Struct({ region: Schema.String }),
        output: Schema.Array(Incident),
        run: ({ region }) => invoke("operations.incidents", { region }, 540, () => [
          { id: "inc-204", service: "edge-gateway", severity: 2, summary: "Latency elevated" },
          { id: "inc-207", service: "image-proxy", severity: 1, summary: "Error budget watch" },
        ]),
      }),
      openChange: Tool.make({
        description: "Open a controlled remediation change",
        input: Schema.Struct({ service: Schema.String, reason: Schema.String }),
        output: Change,
        run: ({ service, reason }) => invoke("operations.openChange", { service, reason }, 720, () => ({
          id: "chg-882",
          service,
          state: "awaiting-approval",
        })),
      }),
    },
    telemetry: {
      inspect: Tool.make({
        description: "Read a service health snapshot",
        input: Schema.Struct({ service: Schema.String }),
        output: Signal,
        run: ({ service }) => invoke("telemetry.inspect", { service }, service === "edge-gateway" ? 980 : 680, () => ({
          service,
          status: service === "edge-gateway" ? "degraded" : "healthy",
          latencyMs: service === "edge-gateway" ? 384 : 71,
          errorRate: service === "edge-gateway" ? 2.8 : 0.08,
        })),
      }),
    },
  }

  const appendIntrinsicCalls = (result: ExecuteResult): void => {
    const observed = new Map<string, number>()
    for (const entry of entries) observed.set(entry.name, (observed.get(entry.name) ?? 0) + 1)
    const visited = new Map<string, number>()
    for (const call of result.toolCalls) {
      const position = (visited.get(call.name) ?? 0) + 1
      visited.set(call.name, position)
      if (position <= (observed.get(call.name) ?? 0)) continue
      entries = [...entries, {
        id: nextId++,
        name: call.name,
        args: call.args[0],
        startedAt: performance.now(),
        state: result.ok ? "succeeded" : "failed",
        durationMs: 0,
      }]
    }
    publish(entries)
  }

  return { tools, appendIntrinsicCalls }
}

const catalogRuntime = makeRuntime(() => undefined)
const availableTools = catalog(catalogRuntime.tools)

export function App() {
  const prefersReducedMotion = useReducedMotion()
  const [scenarioIndex, setScenarioIndex] = useState(0)
  const [code, setCode] = useState(scenarios[0]?.code ?? "")
  const [runState, setRunState] = useState<RunState>("idle")
  const [statusText, setStatusText] = useState("ready")
  const [result, setResult] = useState("Select an example and execute it.")
  const [auditEntries, setAuditEntries] = useState<ReadonlyArray<AuditEntry>>([])
  const [elapsed, setElapsed] = useState(0)
  const [inspectedTool, setInspectedTool] = useState("telemetry.inspect")
  const startedAt = useRef(0)
  const programBackdrop = useRef<HTMLPreElement>(null)

  const runningTools = new Set<string>()
  for (const entry of auditEntries) {
    if (entry.state === "running") runningTools.add(entry.name)
  }
  const newestEntry = auditEntries.at(-1)
  const displayedSource = toolSources[inspectedTool] ?? toolSources["telemetry.inspect"]
  const inspectedEntry = auditEntries.findLast((entry) => entry.name === inspectedTool)
  const hostRunningLine = inspectedEntry?.state === "running" ? displayedSource?.runningLine : undefined
  const hostCompletedLine = inspectedEntry?.state === "succeeded" ? displayedSource?.completedLine : undefined

  const publishAudit = (entries: ReadonlyArray<AuditEntry>): void => {
    setAuditEntries(entries)
    const latestProvided = entries.findLast((entry) => toolSources[entry.name] !== undefined)
    if (latestProvided) setInspectedTool(latestProvided.name)
  }

  const programLineState = (line: string): { activeLine?: number; completedLine?: number } => {
    const tool = Object.keys(toolSources).find((name) => line.includes(`tools.${name}`))
    if (!tool) return {}
    if (runningTools.has(tool)) return { activeLine: 0 }
    if (newestEntry?.name === tool && newestEntry.state === "succeeded") return { completedLine: 0 }
    return {}
  }

  const syncEditorScroll = (event: UIEvent<HTMLTextAreaElement>): void => {
    if (!programBackdrop.current) return
    programBackdrop.current.scrollTop = event.currentTarget.scrollTop
    programBackdrop.current.scrollLeft = event.currentTarget.scrollLeft
  }

  const chooseScenario = (index: number): void => {
    const scenario = scenarios[index]
    if (!scenario || runState === "running") return
    setScenarioIndex(index)
    setCode(scenario.code)
  }

  const execute = async (): Promise<void> => {
    if (runState === "running") return
    setAuditEntries([])
    setResult("Awaiting Effect capabilities...")
    setRunState("running")
    setStatusText("running")
    setElapsed(0)
    startedAt.current = performance.now()
    const timer = window.setInterval(() => setElapsed(Math.round(performance.now() - startedAt.current)), 32)
    const runtime = makeRuntime(publishAudit)
    const rune = Rune.make({ tools: runtime.tools, limits: { timeoutMs: 8_000, maxConcurrency: 3 } })

    const execution = await Effect.runPromise(rune.run(code))
    runtime.appendIntrinsicCalls(execution)
    window.clearInterval(timer)
    setElapsed(Math.round(performance.now() - startedAt.current))

    if (execution.ok) {
      setResult(format(execution.value))
      setRunState("success")
      setStatusText("completed")
      return
    }

    setResult(format(execution.error))
    setRunState("failure")
    setStatusText(execution.error.kind)
  }

  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user" transition={criticalSpring}>
        <m.main className="shell isolate" initial={prefersReducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
      <header className="header">
        <a className="wordmark" href="./" aria-label="Rune home">
          <span className="mark" aria-hidden="true">R</span>
          <span>rune</span>
        </a>
        <div className="header-links">
          <span className="runtime-badge"><span className="pulse" aria-hidden="true" /> Effect runtime</span>
          <a className="link" href="https://github.com/kitlangton/rune">GitHub</a>
        </div>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Confined TypeScript code mode</p>
          <h1 id="page-title">Watch confined tools run.</h1>
          <p className="lede">
            A Rune Program calling schema-checked Effect capabilities in the browser.
          </p>
        </div>
        <dl className="metrics" aria-label="Execution overview">
          <div><dt>Tool calls</dt><dd className="tabular">{auditEntries.length}</dd></div>
          <div><dt>Elapsed</dt><dd className="tabular">{elapsed} ms</dd></div>
          <div><dt>Boundary</dt><dd className="secure">confined</dd></div>
        </dl>
      </section>

      <section className="workbench" aria-label="Rune workbench">
        <div className="editor-column">
          <section className="panel editor-panel" aria-labelledby="program-title">
            <div className="panel-top">
              <div>
                <p className="panel-kicker">Rune Program</p>
                <h2 id="program-title">Agent response</h2>
              </div>
              <div className="scenario-tabs" aria-label="Example programs">
                {scenarios.map((scenario, index) => (
                  <m.button
                    className={`scenario ${scenarioIndex === index ? "active" : ""}`}
                    type="button"
                    key={scenario.title}
                    aria-pressed={scenarioIndex === index}
                    disabled={runState === "running"}
                    onClick={() => chooseScenario(index)}
                    whileTap={{ scale: 0.97 }}
                  >
                    {scenario.title}
                  </m.button>
                ))}
              </div>
            </div>
            <label className="sr-only" htmlFor="code">Edit Rune Program</label>
            <div className="code-editor">
              <pre className="highlighted-code" ref={programBackdrop} aria-hidden="true">
                <code>
                  {code.split("\n").map((line, index) => {
                    const state = programLineState(line)
                    return (
                      <span className={`code-line ${state.activeLine === 0 ? "executing" : state.completedLine === 0 ? "executed" : ""}`} key={`${index}-${line}`}>
                        <span className="line-number tabular">{String(index + 1).padStart(2, "0")}</span>
                        <span className="line-source">{syntax(line)}</span>
                      </span>
                    )
                  })}
                </code>
              </pre>
              <textarea
                className="editor"
                id="code"
                spellCheck={false}
                aria-describedby="program-hint"
                value={code}
                disabled={runState === "running"}
                onScroll={syncEditorScroll}
                onChange={(event) => setCode(event.currentTarget.value)}
              />
            </div>
            <div className="editor-footer">
              <p className="hint" id="program-hint">Plain data and explicit <code>tools.*</code> calls only.</p>
              <div className="actions">
                <m.button
                  className="secondary"
                  type="button"
                  disabled={runState === "running"}
                  onClick={() => chooseScenario(scenarioIndex)}
                  whileTap={{ scale: 0.97 }}
                >
                  Reset
                </m.button>
                <m.button
                  className="primary"
                  type="button"
                  disabled={runState === "running"}
                  onClick={() => void execute()}
                  whileTap={{ scale: 0.97 }}
                >
                  <span className="run-dot" aria-hidden="true" />
                  <span>{runState === "running" ? "Running" : "Execute"}</span>
                </m.button>
              </div>
            </div>
          </section>

          <section className="panel capabilities" aria-labelledby="capabilities-title">
            <div className="panel-top compact">
              <div>
                <p className="panel-kicker">Provided tools</p>
                <h2 id="capabilities-title">Host capability</h2>
              </div>
              <span className="count">{availableTools.length} defined</span>
            </div>
            <ul className="catalog" role="list">
              {availableTools.map((capability) => (
                <li key={capability.path}>
                  <button className={`capability ${inspectedTool === capability.path ? "selected" : ""}`} type="button" onClick={() => setInspectedTool(capability.path)}>
                    <code className="signature">tools.{capability.path}</code>
                    <span className="description">{capability.description}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className={`boundary ${inspectedEntry?.state === "running" ? "live" : ""}`}>
              <span>Rune Program</span>
              <span className="boundary-line" aria-hidden="true" />
              <span>ToolRuntime.invoke</span>
              <span className="boundary-line" aria-hidden="true" />
              <span>Effect</span>
            </div>
            <pre className="tool-source">
              <CodeView lines={displayedSource?.lines ?? []} activeLine={hostRunningLine} completedLine={hostCompletedLine} />
            </pre>
          </section>
        </div>

        <div className="runtime-column">
          <section className="panel output-panel" aria-labelledby="output-title">
            <div className="panel-top compact">
              <div>
                <p className="panel-kicker">Execution result</p>
                <h2 id="output-title">Value</h2>
              </div>
              <m.span className={`state ${runState}`} layout>{statusText}</m.span>
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <m.pre
                className="output"
                key={`${runState}-${result}`}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
              >
                {result}
              </m.pre>
            </AnimatePresence>
          </section>

          <section className="panel log-panel" aria-labelledby="log-title">
            <div className="panel-top compact">
              <div>
                <p className="panel-kicker">Audit trail</p>
                <h2 id="log-title">Tool invocations</h2>
              </div>
              <span className="count tabular">{auditEntries.length} {auditEntries.length === 1 ? "event" : "events"}</span>
            </div>
            <ol className="log" role="list">
              <AnimatePresence initial={false}>
                {auditEntries.length === 0 ? (
                  <m.li className="empty-log" key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    No capabilities invoked yet.
                  </m.li>
                ) : auditEntries.map((entry) => (
                  <m.li
                    layout
                    className="event"
                    key={entry.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                  >
                    <div className="event-time tabular">+{Math.round(entry.startedAt - startedAt.current)} ms</div>
                    <div className="event-main">
                      <p className="event-name">tools.{entry.name}</p>
                      <p className="event-args">{format(entry.args).replaceAll("\n", " ")}</p>
                    </div>
                    <m.span className={`event-status ${entry.state}`} layout>
                      {entry.state === "running" ? "running" : `${entry.state} / ${entry.durationMs ?? 0} ms`}
                    </m.span>
                  </m.li>
                ))}
              </AnimatePresence>
            </ol>
          </section>
        </div>
      </section>
        </m.main>
      </MotionConfig>
    </LazyMotion>
  )
}
