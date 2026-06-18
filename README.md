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
import { createCompiler } from "tswasm";

const compiler = await createCompiler();
const result = compiler.compile(`const main = (): Promise<number> => 42`);

console.log(result.js); // const main = () => 42;

compiler.compile(`const s: string = 42`) // { success: false, diagnostics: [{..., message: "Type 'number' is not assignable to type 'string'.", ...}] }
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
pnpm exec tsx bench/compile.bench.ts --filter=warm
pnpm exec tsx bench/compile.bench.ts --skip-native --json=tasks/bench-results.ignoreme.json
```

`pnpm bench` builds `tswasm`, builds a local native `tsgo` CLI from
`typescript-go/`, and then prints Markdown tables. `bench:quick` uses shorter
sample windows for iteration while changing benchmark code.

The benchmark has two source cases:

- `simple snippet`: the existing compile-test async function using `Map`,
  `Array.from`, and `Promise.all`.
- `type-heavy snippet`: a compact source using recursive conditional types,
  mapped type key remapping, template literal types, and generic call-site
  inference.

The rows are intentionally not all equivalent:

- `tswasm warm compile`: one shared `createCompiler()` result for the whole
  process; timed work is only `compiler.compile(code)`.
- `tswasm cold createCompiler+compile`: timed work includes `createCompiler()`
  and one compile. Repeated samples currently accumulate Go wasm runtimes
  because the public API has no disposal hook.
- `TypeScript JS full program (in-memory)`: recreates an in-memory
  `ts.createProgram`, collects pre-emit diagnostics, and emits.
- `TypeScript JS transpileModule (emit only)`: intentionally favorable baseline
  for the classic JS compiler. It does not typecheck.
- `ts-morph full program (in-memory)`: creates an in-memory ts-morph project,
  collects pre-emit diagnostics, and emits to memory.
- `tsgo native CLI (process+files)`: runs the local native TypeScript CLI in a
  subprocess against a temp project. This includes process startup and file
  reads/writes, so it is not equivalent to the tswasm in-memory warm path.

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

### Simple Snippet

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| TypeScript JS transpileModule (emit only) | 0.6198 | 0.3674 | 807 | fastest | rme 10.91% |
| tsgo native CLI (process+files) | 52.40 | 44.92 | 5 | 84.54x slower | fixed samples |
| tswasm warm compile | 53.92 | 50.42 | 10 | 86.99x slower | rme 17.35% |
| tswasm cold createCompiler+compile | 108.6 | 113.3 | 5 | 175.27x slower | fixed samples |
| ts-morph full program (in-memory) | 141.0 | 123.8 | 10 | 227.42x slower | rme 18.43% |
| TypeScript JS full program (in-memory) | 236.6 | 227.7 | 10 | 381.73x slower | rme 8.14% |

### Type-Heavy Snippet

| Benchmark | mean ms | median ms | samples | vs fastest | notes |
|---|---:|---:|---:|---:|---|
| TypeScript JS transpileModule (emit only) | 0.6128 | 0.4635 | 823 | fastest | rme 6.64% |
| tsgo native CLI (process+files) | 32.88 | 32.18 | 5 | 53.67x slower | fixed samples |
| tswasm warm compile | 38.68 | 37.64 | 13 | 63.12x slower | rme 10.30% |
| tswasm cold createCompiler+compile | 82.90 | 72.54 | 5 | 135.28x slower | fixed samples |
| ts-morph full program (in-memory) | 96.48 | 95.83 | 10 | 157.46x slower | rme 6.23% |
| TypeScript JS full program (in-memory) | 297.4 | 259.7 | 10 | 485.43x slower | rme 19.44% |

## Upstream Layout

- `typescript-go/` is a git subtree of `microsoft/typescript-go`.
- `go/tswasm-wasm/` is this package's wasm command source.
- `scripts/build-wasm.ts` overlays the command into
  `typescript-go/cmd/tswasm-wasm`, copies the needed lib definition files, and
  builds `dist/tswasm.wasm`.

That keeps the public package separate from upstream while still allowing the Go
entrypoint to reach tsgo's current internal compiler APIs.
