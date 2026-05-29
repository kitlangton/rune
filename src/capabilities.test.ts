import { mkdtemp, mkdir, readFile, readlink, realpath, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Option, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { Clock } from "./clock.ts"
import { Rune } from "./rune.ts"
import { Fs } from "./fs.ts"
import { Http } from "./http.ts"
import { Store } from "./store.ts"
import { expectOk, isWellFormedResult } from "./test-harness.ts"
import { Tool } from "./tool.ts"
import { Rune as PromiseRune, Tool as PromiseTool } from "./promise.ts"

describe("policy", () => {
  const publish = Tool.make({
    description: "Publish a message",
    input: Schema.String,
    output: Schema.String,
    approval: "required",
    run: (input) => Effect.succeed(input),
  })

  test("requests boolean approval before a required capability runs", async () => {
    let attempted = 0
    const tool = Tool.make({
      description: "Publish a message",
      input: Schema.String,
      output: Schema.String,
      approval: "required",
      run: (input) => Effect.sync(() => { attempted += 1; return input }),
    })
    const rune = Rune.make({ tools: { publish: tool }, requestApproval: () => false })
    const result = await Effect.runPromise(rune.run(`return await tools.publish("hello")`))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected denial")
    expect(result.error.kind).toBe("ApprovalDenied")
    expect(isWellFormedResult(result)).toBe(true)
    expect(attempted).toBe(0)
  })

  test("uses allow as an allowlist and requires explicit auto-approval for sensitive tools", async () => {
    const allowed = Rune.make({
      tools: { publish },
      policy: { allow: ["publish"], autoApprove: ["publish"] },
    })
    expect(expectOk(await Effect.runPromise(allowed.run(`return await tools.publish("ok")`))).value).toBe("ok")

    const omitted = Rune.make({
      tools: { publish },
      policy: { allow: [] },
    })
    const omittedResult = await Effect.runPromise(omitted.run(`return await tools.publish("no")`))
    expect(omittedResult.ok).toBe(false)
    if (omittedResult.ok) throw new Error("Expected allowlist denial")
    expect(omittedResult.error.kind).toBe("UnknownCapability")
    expect(omittedResult.toolCalls).toEqual([])

    const denied = Rune.make({
      tools: { publish },
      policy: { deny: [{ path: "publish", reason: "Disabled in this workflow" }] },
    })
    const result = await Effect.runPromise(denied.run(`return await tools.publish("no")`))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected denial")
    expect(result.error.kind).toBe("UnknownCapability")
    expect(isWellFormedResult(result)).toBe(true)
    expect(result.toolCalls).toEqual([])
  })

  test("denied capabilities are omitted from discovery", async () => {
    const rune = Rune.make({ tools: { publish }, policy: { deny: ["publish"] } })
    expect(rune.instructions()).not.toContain("tools.publish")
    expect(rune.catalog()).toEqual([])
    const searched = await Effect.runPromise(rune.run(`return await tools.$rune.search({ query: "publish" })`))
    expect(expectOk(searched).value).toEqual({ items: [], total: 0 })
  })

  test("discovery is reserved and governed by policy", async () => {
    expect(() => Rune.make({ tools: { $rune: { publish } } })).toThrow("reserved")
    const rune = Rune.make({ tools: { publish }, policy: { allow: ["publish"] } })
    const hidden = await Effect.runPromise(rune.run(`return await tools.$rune.search({ query: "publish" })`))
    expect(hidden.ok).toBe(false)
    if (hidden.ok) throw new Error("Expected discovery to be excluded from the allowlist")
    expect(hidden.error.kind).toBe("UnknownCapability")
    expect(hidden.toolCalls).toEqual([])
  })

  test("passes policy reasons to Effect-based approval handlers", async () => {
    let requested: unknown
    const rune = Rune.make({
      tools: { publish },
      policy: { requireApproval: [{ path: "publish", reason: "Review external message" }] },
      requestApproval: (request) => Effect.sync(() => {
        requested = request
        return true
      }),
    })

    expect(expectOk(await Effect.runPromise(rune.run(`return await tools.publish("hello")`))).value).toBe("hello")
    expect(requested).toEqual({ path: "publish", input: "hello", reason: "Review external message" })
    const described = expectOk(await Effect.runPromise(rune.run(`return await tools.$rune.describe({ path: "publish" })`)))
    expect((described.value as { signature: string }).signature).toContain("Requires approval")
  })

  test("does not request approval for invalid described-tool input", async () => {
    let requests = 0
    const rune = Rune.make({
      tools: { publish },
      requestApproval: () => Effect.sync(() => { requests += 1; return true }),
    })
    const result = await Effect.runPromise(rune.run(`return await tools.publish(123)`))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected invalid input")
    expect(result.error.kind).toBe("InvalidToolInput")
    expect(requests).toBe(0)
    expect(result.toolCalls).toEqual([])
  })

  test("decodes encoded outputs before exposing them to a Rune Program", async () => {
    const count = Tool.make({
      description: "Read a count",
      input: Schema.Struct({}),
      output: Schema.NumberFromString,
      run: () => Effect.succeed("42"),
    })
    const result = await Effect.runPromise(Rune.make({ tools: { count } }).run(`return await tools.count({}) + 1`))
    expect(expectOk(result).value).toBe(43)
    expect(Rune.make({ tools: { count } }).catalog()[0]?.signature).toContain("Promise<number>")
  })
})

describe("Promise adapter policy", () => {
  test("supports Promise approvals and policy-hidden capabilities", async () => {
    let executed = 0
    const denied = PromiseRune.make({
      tools: { publish: PromiseTool.make({ description: "Publish", input: Schema.Struct({}), output: Schema.String, run: () => { executed += 1; return "sent" } }) },
      policy: { requireApproval: ["publish"] },
      requestApproval: async () => false,
    })
    const rejected = await denied.run(`return tools.publish({})`)
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error("Expected approval rejection")
    expect(rejected.error.kind).toBe("ApprovalDenied")
    expect(executed).toBe(0)
    expect(rejected.toolCalls).toEqual([])

    const hidden = PromiseRune.make({
      tools: { publish: PromiseTool.make({ description: "Publish", input: Schema.Struct({}), output: Schema.String, run: () => "sent" }) },
      policy: { deny: ["publish"] },
    })
    expect(hidden.catalog()).toEqual([])
    expect(hidden.instructions()).not.toContain("tools.publish")
    expect(expectOk(await hidden.run(`return tools.$rune.search({ query: "publish" })`)).value).toEqual({ items: [], total: 0 })
  })
})

describe("standard capabilities", () => {
  test("clock and session store execute as ordinary capabilities", async () => {
    const rune = Rune.make({
      tools: { clock: Clock.make({ maxSleepMs: 0 }), store: Store.memory() },
    })
    const result = await Effect.runPromise(rune.run(`
      const now = await tools.clock.now({})
      await tools.clock.sleep({ ms: 0 })
      await tools.store.put({ key: "run", value: now.iso })
      return await tools.store.get({ key: "run" })
    `))
    const ok = expectOk(result)
    expect(typeof (ok.value as { value: string }).value).toBe("string")
  })

  test("session store bounds retained values and releases budget on delete", async () => {
    const rune = Rune.make({
      tools: { store: Store.memory({ maxBytes: 40 }) },
    })

    expect(expectOk(await Effect.runPromise(rune.run(`return await tools.store.put({ key: "a", value: "1234567890" })`))).value).toEqual({ stored: true })
    const full = await Effect.runPromise(rune.run(`return await tools.store.put({ key: "b", value: "1234567890" })`))
    expect(full.ok).toBe(false)
    if (full.ok) throw new Error("Expected retained-size rejection")
    expect(full.error.kind).toBe("CapabilityFailure")
    expect(full.error.message).toContain("maximum retained size")

    expect(expectOk(await Effect.runPromise(rune.run(`return await tools.store.delete({ key: "a" })`))).value).toEqual({ deleted: true })
    expect(expectOk(await Effect.runPromise(rune.run(`return await tools.store.put({ key: "b", value: "1234567890" })`))).value).toEqual({ stored: true })

    expect(expectOk(await Effect.runPromise(rune.run(`const missing = {}; await tools.store.put({ key: "b", value: missing.value }); return await tools.store.get({ key: "b" })`))).value).toEqual({ value: undefined })
  })

  test("session store rejects invalid configured bounds", () => {
    expect(() => Store.memory({ maxKeys: 0 })).toThrow()
    expect(() => Store.memory({ maxBytes: 0 })).toThrow()
  })

  test("standard packs reject invalid configured limits", () => {
    expect(() => Clock.make({ maxSleepMs: -1 })).toThrow()
    expect(() => Fs.readonly({ root: ".", maxReadBytes: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => Fs.workspace({ root: ".", maxWriteBytes: 0 })).toThrow()
    expect(() => Http.targets({ api: { origin: "https://api.example.com" } }, { maxResponseBytes: 0 })).toThrow()
    expect(() => Http.targets({ "github-api": { origin: "https://api.example.com" } })).toThrow()
  })

  test("session store is scratch state by default but can opt into approval", async () => {
    const scratch = Rune.make({ tools: { store: Store.memory() } })
    expect(expectOk(await Effect.runPromise(scratch.run(`return await tools.store.put({ key: "a", value: 1 })`))).value).toEqual({ stored: true })

    const guarded = Rune.make({ tools: { store: Store.memory({ approval: "required" }) } })
    const denied = await Effect.runPromise(guarded.run(`return await tools.store.put({ key: "a", value: 1 })`))
    expect(denied.ok).toBe(false)
    if (denied.ok) throw new Error("Expected approval denial")
    expect(denied.error.kind).toBe("ApprovalDenied")
    expect(denied.toolCalls).toEqual([])
  })

  test("mounted filesystem reads and approval-gated writes stay under root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rune-fs-"))
    await mkdir(join(root, "docs"))
    await writeFile(join(root, "docs", "readme.md"), "hello")
    const layer = FileSystem.layerNoop({
      realPath: (path) => Effect.promise(() => realpath(path)),
      readFileString: (path) => Effect.promise(() => readFile(path, "utf8")),
      readLink: (path) => Effect.promise(async () => { try { return await readlink(path) } catch { return "" } }),
      stream: (path) => Stream.fromEffect(Effect.promise(() => readFile(path))).pipe(Stream.map((data) => new Uint8Array(data))),
      readDirectory: (path) => Effect.promise(() => readdir(path)),
      exists: (path) => Effect.promise(async () => { try { await stat(path); return true } catch { return false } }),
      writeFileString: (path, data) => Effect.promise(() => writeFile(path, data)),
      remove: (path) => Effect.promise(() => rm(path)),
      stat: (path) => Effect.promise(async () => {
        const value = await stat(path)
        return {
          type: value.isDirectory() ? "Directory" : "File",
          mtime: Option.none(), atime: Option.none(), birthtime: Option.none(), dev: 0,
          ino: Option.none(), mode: 0, nlink: Option.none(), uid: Option.none(), gid: Option.none(),
          rdev: Option.none(), size: FileSystem.Size(value.size), blksize: Option.none(), blocks: Option.none(),
        }
      }),
    })
    const rune = Rune.make({
      tools: { fs: Fs.workspace({ root }) },
      requestApproval: () => true,
    })
    const result = await Effect.runPromise(rune.run(`
      const input = await tools.fs.readText({ path: "docs/readme.md" })
      await tools.fs.writeText({ path: "docs/copy.md", text: input.text + " world" })
      return await tools.fs.readText({ path: "docs/copy.md" })
    `).pipe(Effect.provide(layer)))
    expect(expectOk(result).value).toEqual({ text: "hello world" })

    const escaped = await Effect.runPromise(rune.run(`return await tools.fs.readText({ path: "../secret" })`).pipe(Effect.provide(layer)))
    expect(escaped.ok).toBe(false)
    if (escaped.ok) throw new Error("Expected filesystem boundary rejection")
    expect(escaped.error.kind).toBe("CapabilityFailure")

    const limited = Rune.make({ tools: { fs: Fs.readonly({ root, maxReadBytes: 4 }) } })
    const oversized = await Effect.runPromise(limited.run(`return await tools.fs.readText({ path: "docs/readme.md" })`).pipe(Effect.provide(layer)))
    expect(oversized.ok).toBe(false)
    if (oversized.ok) throw new Error("Expected filesystem size rejection")
    expect(oversized.error.message).toContain("exceeds 4 bytes")

    const outside = await mkdtemp(join(tmpdir(), "rune-fs-outside-"))
    await writeFile(join(outside, "secret.md"), "secret")
    await symlink(join(outside, "secret.md"), join(root, "docs", "linked.md"))
    await symlink(outside, join(root, "linked-dir"))

    const linkedRead = await Effect.runPromise(rune.run(`return await tools.fs.readText({ path: "docs/linked.md" })`).pipe(Effect.provide(layer)))
    expect(linkedRead.ok).toBe(false)

    const linkedWrite = await Effect.runPromise(rune.run(`return await tools.fs.writeText({ path: "linked-dir/copy.md", text: "escaped" })`).pipe(Effect.provide(layer)))
    expect(linkedWrite.ok).toBe(false)

    const overwriteLink = await Effect.runPromise(rune.run(`return await tools.fs.writeText({ path: "docs/linked.md", text: "overwritten" })`).pipe(Effect.provide(layer)))
    expect(overwriteLink.ok).toBe(false)
    const removeLink = await Effect.runPromise(rune.run(`return await tools.fs.remove({ path: "docs/linked.md" })`).pipe(Effect.provide(layer)))
    expect(removeLink.ok).toBe(false)
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("secret")

    await symlink(join(outside, "created.md"), join(root, "docs", "dangling.md"))
    const danglingWrite = await Effect.runPromise(rune.run(`return await tools.fs.writeText({ path: "docs/dangling.md", text: "escaped" })`).pipe(Effect.provide(layer)))
    expect(danglingWrite.ok).toBe(false)
    expect(await readdir(outside)).toEqual(["secret.md"])
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  test("named HTTP targets are policy-addressable capabilities and require approval", async () => {
    const previous = globalThis.fetch
    const mockFetch = (async (input) => String(input).endsWith("/redirect")
      ? new Response(null, { status: 302, headers: { location: "https://internal.example/admin" } })
      : new Response(
          String(input).endsWith("/large") ? "response-too-large" : JSON.stringify({ url: String(input) }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch
    globalThis.fetch = mockFetch
    try {
      const rune = Rune.make({
        tools: { http: Http.targets({ api: { origin: "https://api.example.com", methods: ["GET"], pathPrefixes: ["/v1/"] } }) },
        requestApproval: () => true,
      })
      expect(rune.catalog()[0]?.path).toBe("http.api.get")
      const ok = await Effect.runPromise(rune.run(`return await tools.http.api.get({ path: "/v1/issues" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(expectOk(ok).value).toEqual({ status: 200, body: { url: "https://api.example.com/v1/issues" } })

      const prohibited = Rune.make({
        tools: { http: Http.targets({ api: { origin: "https://api.example.com", methods: ["GET"] } }) },
        policy: { deny: ["http.api.get"] },
      })
      const denied = await Effect.runPromise(prohibited.run(`return await tools.http.api.get({ path: "/" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(denied.ok).toBe(false)
      if (denied.ok) throw new Error("Expected HTTP policy denial")
      expect(denied.error.kind).toBe("UnknownCapability")
      expect(denied.toolCalls).toEqual([])

      const blocked = await Effect.runPromise(rune.run(`return await tools.http.api.get({ path: "/admin" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(blocked.ok).toBe(false)
      if (blocked.ok) throw new Error("Expected HTTP path rejection")
      expect(blocked.error.kind).toBe("CapabilityFailure")

      const normalizedEscape = await Effect.runPromise(rune.run(`return await tools.http.api.get({ path: "/v1/../admin" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(normalizedEscape.ok).toBe(false)
      const encodedEscape = await Effect.runPromise(rune.run(`return await tools.http.api.get({ path: "/v1/%2e%2e/admin" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(encodedEscape.ok).toBe(false)

      const segmentTarget = Rune.make({
        tools: { http: Http.targets({ api: { origin: "https://api.example.com", methods: ["GET"], pathPrefixes: ["/v1"] } }) },
        requestApproval: () => true,
      })
      const siblingPrefix = await Effect.runPromise(segmentTarget.run(`return await tools.http.api.get({ path: "/v10/admin" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(siblingPrefix.ok).toBe(false)

      const limited = Rune.make({
        tools: { http: Http.targets({ api: { origin: "https://api.example.com", methods: ["GET"], pathPrefixes: ["/v1/"] } }, { maxResponseBytes: 4 }) },
        requestApproval: () => true,
      })
      const oversized = await Effect.runPromise(limited.run(`return await tools.http.api.get({ path: "/v1/large" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(oversized.ok).toBe(false)
      if (oversized.ok) throw new Error("Expected HTTP size rejection")
      expect(oversized.error.message).toContain("exceeds 4 bytes")

      const redirected = await Effect.runPromise(rune.run(`return await tools.http.api.get({ path: "/v1/redirect" })`).pipe(Effect.provide(FetchHttpClient.layer)))
      expect(redirected.ok).toBe(false)
      if (redirected.ok) throw new Error("Expected redirect rejection")
      expect(redirected.error.message).toContain("redirects are not allowed")

      expect(() => Http.targets({ internal: { origin: "https://localhost", methods: ["GET"] } })).toThrow()

      for (const origin of ["https://[::1]", "https://[fd00::1]", "https://[fe80::1]", "https://[::ffff:127.0.0.1]"]) {
        expect(() => Http.targets({ internal: { origin, methods: ["GET"] } })).toThrow()
      }
    } finally {
      globalThis.fetch = previous
    }
  })
})
