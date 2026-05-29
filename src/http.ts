import { Effect, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { readBoundedText } from "./bounded-stream.js"
import { capabilityError } from "./capability-error.js"
import { Tool } from "./tool.js"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type Target = {
  readonly origin: string
  readonly methods?: ReadonlyArray<Method>
  readonly pathPrefixes?: ReadonlyArray<string>
  readonly headers?: Readonly<Record<string, string>>
}

export type Options = {
  readonly maxResponseBytes?: number
  readonly allowPrivateTargets?: boolean
}

const privateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    host.startsWith("fc") && host.includes(":") ||
    host.startsWith("fd") && host.includes(":") ||
    /^fe[89ab]/.test(host) && host.includes(":") ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("169.254.") ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
}

const defaultMethods = ["GET"] as const

type AllowedMethod<T extends Target> = T["methods"] extends ReadonlyArray<infer M extends Method> ? M : "GET"
type TargetTools<T extends Target> = { readonly [M in AllowedMethod<T> as Lowercase<M>]: ReturnType<typeof methodTool> }

const validatePositiveBytes = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`)
}

const methodTool = (targetName: string, config: Target, method: Method, options: Options) =>
  Tool.make({
    description: `Make a ${method} HTTP request to the configured '${targetName}' target`,
    input: Schema.Struct({
      path: Schema.String,
      json: Schema.optional(Schema.Unknown),
    }),
    output: Schema.Struct({ status: Schema.Number, body: Schema.Unknown }),
    approval: "required",
    run: ({ path, json }) => Effect.gen(function*() {
      const origin = new URL(config.origin)
      if (origin.protocol !== "https:") return yield* capabilityError("HTTP targets must use https.")
      if (!options.allowPrivateTargets && privateHost(origin.hostname)) return yield* capabilityError("HTTP private or loopback targets are not allowed.")
      if (!path.startsWith("/") || path.startsWith("//")) return yield* capabilityError("HTTP request path must be an absolute path without an origin.")
      const url = new URL(path, origin)
      if (url.origin !== origin.origin) return yield* capabilityError("HTTP request escaped its configured target origin.")
      const normalizedPath = new URL(decodeURIComponent(url.pathname), origin).pathname
      const allowsPath = (prefix: string): boolean => {
        const normalizedPrefix = prefix === "/" ? "/" : prefix.replace(/\/$/, "")
        return normalizedPrefix === "/" || normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)
      }
      if (config.pathPrefixes && !config.pathPrefixes.some(allowsPath)) {
        return yield* capabilityError(`HTTP path '${normalizedPath}' is not allowed for target '${targetName}'.`)
      }
      let request = HttpClientRequest.make(method)(url).pipe(
        HttpClientRequest.setHeaders({ "content-type": "application/json", ...config.headers }),
      )
      if (json !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, json)
      const response = yield* HttpClient.execute(request)
      if (response.status >= 300 && response.status < 400) {
        return yield* capabilityError("HTTP redirects are not allowed for named targets.")
      }
      const maxResponseBytes = options.maxResponseBytes ?? 256_000
      const text = yield* readBoundedText(response.stream, maxResponseBytes, "HTTP response")
      const contentType = response.headers["content-type"] ?? ""
      const body = contentType.includes("application/json")
        ? yield* Effect.try({ try: () => JSON.parse(text), catch: (cause) => capabilityError(`Invalid JSON response: ${String(cause)}`, cause) })
        : text
      return { status: response.status, body }
    }),
  })

/**
 * Creates HTTPS capabilities addressed by target and method, such as `http.github.get`.
 * Requests require approval by default. The injected transport must expose redirects rather
 * than following them invisibly when redirect confinement matters.
 *
 * @example `Http.targets({ github: { origin: "https://api.github.com", methods: ["GET"] } })`
 */
export const targets = <const Targets extends Readonly<Record<string, Target>>>(
  configured: Targets,
  options: Options = {},
): { readonly [K in keyof Targets]: TargetTools<Targets[K]> } => {
  const maxResponseBytes = options.maxResponseBytes ?? 256_000
  validatePositiveBytes("http maxResponseBytes", maxResponseBytes)
  const tools: Record<string, Record<string, ReturnType<typeof methodTool>>> = {}
  for (const [name, config] of Object.entries(configured)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || ["constructor", "prototype", "__proto__", "$rune"].includes(name)) {
      throw new Error(`HTTP target name '${name}' is not a callable Rune capability segment.`)
    }
    const origin = new URL(config.origin)
    if (origin.protocol !== "https:") throw new Error("HTTP targets must use https.")
    if (!options.allowPrivateTargets && privateHost(origin.hostname)) throw new Error("HTTP private or loopback targets are not allowed.")
    const methods = config.methods ?? defaultMethods
    if (methods.length === 0) throw new Error(`HTTP target '${name}' must allow at least one method.`)
    tools[name] = Object.fromEntries(methods.map((method) => [method.toLowerCase(), methodTool(name, config, method, { ...options, maxResponseBytes })]))
  }
  return tools as { readonly [K in keyof Targets]: TargetTools<Targets[K]> }
}

export * as Http from "./http.js"
