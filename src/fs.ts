import { resolve, relative, isAbsolute, dirname, sep } from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { readBoundedText } from "./bounded-stream.js"
import { capabilityError } from "./capability-error.js"
import { Tool } from "./tool.js"

export type Options = {
  readonly root: string
  readonly maxReadBytes?: number
  readonly maxWriteBytes?: number
}

const validatePositiveBytes = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`)
}

const lexicalPath = (root: string, path: string): string => {
  if (isAbsolute(path)) throw capabilityError("fs paths must be relative.")
  const absolute = resolve(root, path)
  const rel = relative(resolve(root), absolute)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw capabilityError("fs path is outside the configured root.")
  }
  return absolute
}

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const readTools = (options: Options) => {
  const maxReadBytes = options.maxReadBytes ?? 64_000
  validatePositiveBytes("fs maxReadBytes", maxReadBytes)

  const resolveRead = (path: string) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(resolve(options.root))
    const target = yield* fs.realPath(lexicalPath(options.root, path))
    if (!inside(root, target)) return yield* capabilityError("fs path resolves outside the configured root.")
    return { fs, target }
  })

  const readText = (path: string, capability: string) => Effect.gen(function*() {
    const { fs, target } = yield* resolveRead(path)
    return yield* readBoundedText(fs.stream(target, { bytesToRead: maxReadBytes + 1 }), maxReadBytes, capability)
  })

  return {
    readText: Tool.make({
      description: "Read a UTF-8 text file from the configured workspace root",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
      run: ({ path }) => Effect.map(readText(path, "fs.readText"), (text) => ({ text })),
    }),
    readJson: Tool.make({
      description: "Read and parse a JSON file from the configured workspace root",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Unknown,
      run: ({ path }) => Effect.gen(function*() {
        const text = yield* readText(path, "fs.readJson")
        return yield* Effect.try({ try: () => JSON.parse(text), catch: (cause) => capabilityError(`Invalid JSON: ${String(cause)}`, cause) })
      }),
    }),
    list: Tool.make({
      description: "List entries within the configured workspace root",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ entries: Schema.Array(Schema.String) }),
      run: ({ path }) => Effect.gen(function*() {
        const { fs, target } = yield* resolveRead(path)
        return { entries: yield* fs.readDirectory(target) }
      }),
    }),
  }
}

/**
 * Creates bounded read-only capabilities rooted at a mounted directory.
 * Generic path-backed filesystems cannot eliminate races caused by an untrusted concurrent
 * path mutator; use trusted roots unless the host supplies stronger no-follow primitives.
 *
 * @example `Fs.readonly({ root: "./docs", maxReadBytes: 64_000 })`
 */
export const readonly = (options: Options) => readTools(options)

/**
 * Creates rooted read/write capabilities; writes and removes require approval by default.
 *
 * @example `Fs.workspace({ root: "./workspace" })`
 */
export const workspace = (options: Options) => {
  const maxWriteBytes = options.maxWriteBytes ?? 64_000
  validatePositiveBytes("fs maxWriteBytes", maxWriteBytes)
  const read = readTools(options)

  const resolveWrite = (path: string) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(resolve(options.root))
    const target = lexicalPath(options.root, path)
    const parent = yield* fs.realPath(dirname(target))
    if (!inside(root, parent)) return yield* capabilityError("fs path resolves outside the configured root.")
    const isLink = yield* Effect.match(fs.readLink(target), { onFailure: () => false, onSuccess: (link) => link !== "" })
    if (isLink) return yield* capabilityError("fs writes through symbolic links are not allowed.")
    if (yield* fs.exists(target)) {
      const current = yield* fs.realPath(target)
      if (!inside(root, current)) return yield* capabilityError("fs path resolves outside the configured root.")
    }
    return { fs, target }
  })

  return {
    ...read,
    writeText: Tool.make({
      description: "Write a UTF-8 text file within the configured workspace root",
      input: Schema.Struct({ path: Schema.String, text: Schema.String }),
      output: Schema.Struct({ written: Schema.Boolean }),
      approval: "required",
      run: ({ path, text }) => Effect.gen(function*() {
        if (new TextEncoder().encode(text).byteLength > maxWriteBytes) return yield* capabilityError(`fs.writeText exceeds ${maxWriteBytes} bytes.`)
        const { fs, target } = yield* resolveWrite(path)
        yield* fs.writeFileString(target, text)
        return { written: true }
      }),
    }),
    writeJson: Tool.make({
      description: "Write JSON data within the configured workspace root",
      input: Schema.Struct({ path: Schema.String, value: Schema.Unknown }),
      output: Schema.Struct({ written: Schema.Boolean }),
      approval: "required",
      run: ({ path, value }) => Effect.gen(function*() {
        const text = JSON.stringify(value, null, 2)
        if (new TextEncoder().encode(text).byteLength > maxWriteBytes) return yield* capabilityError(`fs.writeJson exceeds ${maxWriteBytes} bytes.`)
        const { fs, target } = yield* resolveWrite(path)
        yield* fs.writeFileString(target, text)
        return { written: true }
      }),
    }),
    remove: Tool.make({
      description: "Remove a file within the configured workspace root",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ removed: Schema.Boolean }),
      approval: "required",
      run: ({ path }) => Effect.gen(function*() {
        const { fs, target } = yield* resolveWrite(path)
        yield* fs.remove(target)
        return { removed: true }
      }),
    }),
  }
}

export * as Fs from "./fs.js"
