import { Effect, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { readBoundedText } from "./bounded-stream.ts"
import { Tool } from "./tool.ts"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

const Method = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"])

export type Target = {
  readonly origin: string
  readonly methods?: ReadonlyArray<Method>
  readonly pathPrefixes?: ReadonlyArray<string>
  readonly headers?: Readonly<Record<string, string>>
}

export type Options = {
  readonly targets: Readonly<Record<string, Target>>
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

export const targets = (options: Options) => ({
  request: Tool.make({
    description: "Make an HTTP request to a configured named target",
    input: Schema.Struct({
      target: Schema.String,
      method: Method,
      path: Schema.String,
      json: Schema.optional(Schema.Unknown),
    }),
    output: Schema.Struct({ status: Schema.Number, body: Schema.Unknown }),
    approval: "required",
    run: ({ target: targetName, method: methodRaw, path, json }) => Effect.gen(function*() {
      const config = options.targets[targetName]
      if (!config) throw new Error(`Unknown HTTP target '${targetName}'.`)
      const origin = new URL(config.origin)
      if (origin.protocol !== "https:") throw new Error("HTTP targets must use https.")
      if (!options.allowPrivateTargets && privateHost(origin.hostname)) throw new Error("HTTP private or loopback targets are not allowed.")
      if (!path.startsWith("/") || path.startsWith("//")) throw new Error("HTTP request path must be an absolute path without an origin.")
      const methods = config.methods ?? ["GET"]
      if (!methods.includes(methodRaw)) throw new Error(`HTTP method '${methodRaw}' is not allowed for target '${targetName}'.`)
      const url = new URL(path, origin)
      if (url.origin !== origin.origin) throw new Error("HTTP request escaped its configured target origin.")
      const normalizedPath = new URL(decodeURIComponent(url.pathname), origin).pathname
      const allowsPath = (prefix: string): boolean => {
        const normalizedPrefix = prefix === "/" ? "/" : prefix.replace(/\/$/, "")
        return normalizedPrefix === "/" || normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)
      }
      if (config.pathPrefixes && !config.pathPrefixes.some(allowsPath)) {
        throw new Error(`HTTP path '${normalizedPath}' is not allowed for target '${targetName}'.`)
      }
      let request = HttpClientRequest.make(methodRaw)(url).pipe(
        HttpClientRequest.setHeaders({ "content-type": "application/json", ...config.headers }),
      )
      if (json !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, json)
      const response = yield* HttpClient.execute(request)
      if (response.status >= 300 && response.status < 400) {
        throw new Error("HTTP redirects are not allowed for named targets.")
      }
      const maxResponseBytes = options.maxResponseBytes ?? 256_000
      const text = yield* readBoundedText(response.stream, maxResponseBytes, "HTTP response")
      const contentType = response.headers["content-type"] ?? ""
      const body = contentType.includes("application/json")
        ? yield* Effect.try({ try: () => JSON.parse(text), catch: (cause) => new Error(`Invalid JSON response: ${String(cause)}`) })
        : text
      return { status: response.status, body }
    }),
  }),
})

export * as Http from "./http.ts"
