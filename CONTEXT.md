# Rune Context

## Terms

### Rune Program

A TypeScript-shaped orchestration script evaluated by Rune. A Rune Program may transform plain data and call Tool Capabilities, but does not receive ambient JavaScript globals or native callable objects.

### Tool Capability

An explicit host operation addressed through a `tools.*` path inside a Rune Program. The program sees only an opaque path; invocation runs through the Tool Runtime module.

### Described Tool Capability

A Tool Capability registered with a description, input and output Effect Schemas, and an Effect implementation. Rune derives a compact TypeScript capability signature from the schemas. Described Tool Capabilities appear in host-generated instructions and are discoverable through `tools.search(...)` and inspectable through `tools.describe(...)`.

### Data Value

A value permitted to cross between a Rune Program and a Tool Capability: `null`, `undefined`, booleans, finite numbers, strings, arrays of Data Values, and plain objects containing Data Values.

### Tool Runtime

The module that owns Tool Capability resolution, invocation accounting, and Data Value validation. Its core interface accepts Effect-returning tools. Promise-returning host functions are supported through the Rune Promise adapter.

### Rune Promise Adapter

The adapter for applications that expose ordinary values or promises rather than Effects. It translates those tools into Tool Runtime Effects and runs the same Rune execution implementation.

### Rune Intrinsic

A familiar TypeScript-shaped operation implemented by the Rune evaluator rather than obtained from a JavaScript prototype. Rune Intrinsics include common array and string transformations, confined `Object` / `Math` / `JSON` helpers and primitive coercions, plus constrained `Promise.all(...)` for parallel Tool Capability invocation. Their arrow callbacks are Rune Program values and cannot escape as host functions. Intrinsic-produced data remains subject to configured data and collection limits.

### Parallel Tool Invocation

Concurrent execution of independent Tool Capabilities using Effect concurrency. Rune exposes only the common program shapes `Promise.all([tools.a(), tools.b()])` and `Promise.all(items.map((item) => tools.path(item)))`; other shapes fail with retry guidance rather than running arbitrary Rune Program mutations concurrently.

### Diagnostic

Structured failure data returned to the caller when a Rune Program cannot complete. A Diagnostic identifies whether an agent should revise syntax, select another Tool Capability, correct tool data, or reduce requested work under configured resource limits.

### Instructions

The compact host-generated prompt text produced by `rune.instructions()`. `rune.catalog()` exposes the same Described Tool Capabilities as structured values for custom prompting. Both use TypeScript signatures derived from Effect Schemas. Runtime discovery is optional for catalogs that are too large or dynamic to include in Instructions.

### Code Tool

The single agent-facing tool produced by `rune.tool()`. Its description is Instructions and its input is a Rune Program string. A Code Tool replaces exposure of individual Tool Capabilities to an agent framework.

### Adapter

A framework-specific conversion of the neutral Code Tool. `RuneAiSdk` exposes a Vercel AI SDK tool; `RuneEffectAi` exposes an Effect AI Toolkit and handler layer. Additional agent systems can implement Adapters from `rune.tool()`.

### Policy

Optional host configuration evaluated immediately before each Tool Capability invocation. Policy may allow, deny, or require approval for a typed capability path. A Policy restricts configured authority; it never makes an unconfigured capability available.

### Standard Capability Pack

An opt-in collection of Described Tool Capabilities supplied by Rune for common needs such as bounded time, session storage, mounted files, or named HTTP targets. Standard Capability Packs remain ordinary `tools.*` operations and therefore participate in Policy, Instructions, validation, and auditing.
