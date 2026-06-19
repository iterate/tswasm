# tswasm

Proof of concept for packaging `typescript-go` as an embeddable wasm compiler.

This repository keeps `microsoft/typescript-go` as a git subtree, then builds a
small wasm command from inside that subtree. Building from inside the upstream Go
module lets the command legally import `typescript-go/internal/...` without
patching upstream compiler packages.

The initial API compiles one in-memory TypeScript file, `/input.ts`, with modern
ECMAScript lib definitions and returns diagnostics plus emitted JavaScript.

## Usage

```ts
import { createCompiler } from 'tswasm'

const ts = await createCompiler()
const result = ts.compile('const x: number = 123')

console.log(result.success) // true

ts.compile('const s: string = 42') // { success: false, diagnostics: [{..., message: "Type 'number' is not assignable to type 'string'.", ...}] }
```

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

## Benchmarks

This repo includes a local benchmark runner for the current one-file compiler
API:

```bash
pnpm bench
pnpm bench:quick
pnpm bench:profile
pnpm exec tsx bench/compile.bench.ts --filter=warm
pnpm exec tsx bench/compile.bench.ts --skip-native --json=tasks/bench-results.ignoreme.json
```

`pnpm bench` builds `tswasm`, builds a local native `tsgo` CLI from
`typescript-go/`, and then prints Markdown tables. `bench:quick` uses shorter
sample windows for iteration while changing benchmark code. `bench:profile`
adds internal diagnostic rows for the wasm path and a spawn-only `tsgo` row.

The benchmark has two source cases:

- `simple snippet`: the existing compile-test async function using `Map`,
  `Array.from`, and `Promise.all`.
- `type-heavy snippet`: a compact source using recursive conditional types,
  mapped type key remapping, template literal types, and generic call-site
  inference.

The rows are grouped by comparison category. The first category is the main one:
portable full compile, where every row typechecks and emits and can run in the
same wasm-capable environments as `tswasm`.

- `tswasm warm compile`: one shared `createCompiler()` result for the whole
  process; timed work is only `ts.compile(code)`.
- `tswasm cold createCompiler+compile`: timed work includes `createCompiler()`
  and one compile. Repeated samples currently accumulate Go wasm runtimes
  because the public API has no disposal hook.
- `TypeScript JS full program (in-memory)`: recreates an in-memory
  `ts.createProgram`, collects pre-emit diagnostics, and emits.
- `ts-morph full program (in-memory)`: creates an in-memory ts-morph project,
  collects pre-emit diagnostics, and emits to memory.
- `TypeScript JS transpileModule (emit only)`: intentionally favorable baseline
  for the classic JS compiler. It does not typecheck.
- `tsgo native CLI (process+files)`: runs the local native TypeScript CLI in a
  subprocess against a temp project. This includes process startup and file
  reads/writes, so it is a native-Go curiosity rather than a portable
  wasm-environment comparison.

The comparison framing follows:

- Microsoft's native TypeScript announcement measured project-level `tsc` runs
  and reported roughly order-of-magnitude speedups for native TypeScript:
  <https://devblogs.microsoft.com/typescript/typescript-native-port/>
- The TypeScript Compiler API docs distinguish full `createProgram` compilation
  from `transpileModule` emit-only transforms:
  <https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API>
- ts-morph's performance docs call out the wrapper costs around program resets,
  node tracking, and batching:
  <https://ts-morph.com/manipulation/performance>

Representative local run on 2026-06-18:

- Runtime: node v26.0.0 darwin/arm64
- CPU: Apple M4 Max
- TypeScript JS: 5.9.3
- ts-morph: 28.0.0
- tsgo native: Version 7.0.0-dev

Lower latency is better. Tinybench rows use a time-driven loop; startup-heavy
rows use fixed samples.

### Simple Snippet: Portable Full Compile

These rows typecheck and emit, and can run in the same wasm-capable environments
as `tswasm`.

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| tswasm warm compile | 28.90 | 28.11 | 18 | fastest | rme 4.63% |
| tswasm cold createCompiler+compile | 60.51 | 60.86 | 5 | 2.09x slower | fixed samples |
| ts-morph full program (in-memory) | 75.53 | 74.58 | 10 | 2.61x slower | rme 3.99% |
| TypeScript JS full program (in-memory) | 163.2 | 162.2 | 10 | 5.65x slower | rme 3.26% |

### Simple Snippet: Emit-Only Baseline

This classic TypeScript JS row emits without typechecking. It is useful, but not
apples-to-apples. `tswasm` warm compile and TypeScript JS full program are
repeated here as reference points.

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| TypeScript JS transpileModule (emit only) | 0.2819 | 0.1908 | 1774 | fastest | rme 7.55% |
| tswasm warm compile | 28.90 | 28.11 | 18 | 102.52x slower | rme 4.63% |
| TypeScript JS full program (in-memory) | 163.2 | 162.2 | 10 | 579.0x slower | rme 3.26% |

### Simple Snippet: Native Go Curiosity

These rows require native Go or a native helper process. If native Go is
available, use it; these are not portable wasm-environment comparisons. The
`tswasm` rows are repeated here as reference points.

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| tsgo native CLI (process+files) | 27.73 | 26.91 | 5 | fastest | fixed samples |
| tswasm warm compile | 28.90 | 28.11 | 18 | 1.04x slower | rme 4.63% |
| tswasm cold createCompiler+compile | 60.51 | 60.86 | 5 | 2.18x slower | fixed samples |

### Type-Heavy Snippet: Portable Full Compile

These rows typecheck and emit, and can run in the same wasm-capable environments
as `tswasm`.

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| tswasm warm compile | 24.21 | 23.53 | 21 | fastest | rme 6.99% |
| tswasm cold createCompiler+compile | 56.63 | 56.72 | 5 | 2.34x slower | fixed samples |
| ts-morph full program (in-memory) | 68.35 | 66.82 | 10 | 2.82x slower | rme 3.97% |
| TypeScript JS full program (in-memory) | 161.9 | 157.8 | 10 | 6.69x slower | rme 4.59% |

### Type-Heavy Snippet: Emit-Only Baseline

This classic TypeScript JS row emits without typechecking. It is useful, but not
apples-to-apples. `tswasm` warm compile and TypeScript JS full program are
repeated here as reference points.

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| TypeScript JS transpileModule (emit only) | 0.4030 | 0.3025 | 1241 | fastest | rme 5.93% |
| tswasm warm compile | 24.21 | 23.53 | 21 | 60.07x slower | rme 6.99% |
| TypeScript JS full program (in-memory) | 161.9 | 157.8 | 10 | 401.7x slower | rme 4.59% |

### Type-Heavy Snippet: Native Go Curiosity

These rows require native Go or a native helper process. If native Go is
available, use it; these are not portable wasm-environment comparisons. The
`tswasm` rows are repeated here as reference points.

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| tswasm warm compile | 24.21 | 23.53 | 21 | fastest | rme 6.99% |
| tsgo native CLI (process+files) | 28.64 | 27.41 | 5 | 1.18x slower | fixed samples |
| tswasm cold createCompiler+compile | 56.63 | 56.72 | 5 | 2.34x slower | fixed samples |

## Upstream Layout

- `typescript-go/` is a git subtree of `microsoft/typescript-go`.
- `go/tswasm-wasm/` is this package's wasm command source.
- `scripts/build-wasm.ts` overlays the command into
  `typescript-go/cmd/tswasm-wasm`, copies the needed lib definition files, and
  builds `dist/tswasm.wasm`.

That keeps the public package separate from upstream while still allowing the Go
entrypoint to reach tsgo's current internal compiler APIs.
