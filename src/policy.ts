import { Effect } from "effect"

type Leaf = ((...args: Array<unknown>) => unknown) | { readonly _tag: "RuneTool" }

type LeafPath<T, Prefix extends string = ""> = T extends Leaf
  ? Prefix
  : T extends object
    ? { [K in Extract<keyof T, string>]: LeafPath<T[K], Prefix extends "" ? K : `${Prefix}.${K}`> }[Extract<keyof T, string>]
    : never

type NamespacePath<T, Prefix extends string = ""> = T extends Leaf
  ? never
  : T extends object
    ? { [K in Extract<keyof T, string>]:
      T[K] extends Leaf
        ? never
        : (Prefix extends "" ? K : `${Prefix}.${K}`)
          | NamespacePath<T[K], Prefix extends "" ? K : `${Prefix}.${K}`>
    }[Extract<keyof T, string>]
    : never

export type CapabilityPath<Tools> = LeafPath<Tools>
export type Pattern<Tools> = CapabilityPath<Tools> | `${NamespacePath<Tools>}.*` | "*"

export type Entry<P extends string = string> = P | {
  readonly path: P
  readonly reason?: string
}

export type Config<Tools = Record<string, unknown>> = {
  readonly allow?: ReadonlyArray<Entry<Pattern<Tools>>>
  readonly deny?: ReadonlyArray<Entry<Pattern<Tools>>>
  readonly requireApproval?: ReadonlyArray<Entry<Pattern<Tools>>>
}

export type RuntimeConfig = {
  readonly allow?: ReadonlyArray<Entry>
  readonly deny?: ReadonlyArray<Entry>
  readonly requireApproval?: ReadonlyArray<Entry>
}

export type Request<P extends string = string> = {
  readonly path: P
  readonly input: unknown
  readonly reason?: string
}

export type RequestApproval<P extends string = string, R = never> = (
  request: Request<P>,
) => boolean | Effect.Effect<boolean, never, R>

export type Decision =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "requireApproval"; readonly reason?: string }

const unwrap = (entry: Entry): { readonly path: string; readonly reason?: string } =>
  typeof entry === "string" ? { path: entry } : entry

const matches = (pattern: string, path: string): boolean =>
  pattern === "*" || pattern === path || pattern.endsWith(".*") && (path === pattern.slice(0, -2) || path.startsWith(pattern.slice(0, -1)))

const match = (entries: ReadonlyArray<Entry> | undefined, path: string) =>
  entries?.map(unwrap).find((entry) => matches(entry.path, path))

export const decide = (config: RuntimeConfig | undefined, path: string, approvalRequired = false): Decision => {
  const denied = match(config?.deny, path)
  if (denied) return { action: "deny", ...(denied.reason ? { reason: denied.reason } : {}) }

  const allowed = match(config?.allow, path)
  if (allowed) return { action: "allow" }

  const approval = match(config?.requireApproval, path)
  if (approval) return { action: "requireApproval", ...(approval.reason ? { reason: approval.reason } : {}) }

  return approvalRequired ? { action: "requireApproval" } : { action: "allow" }
}

export * as Policy from "./policy.ts"
