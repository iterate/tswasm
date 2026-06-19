# tswasm

Alpha package for running the TypeScript Go compiler from JavaScript runtimes
through WebAssembly.

This repository keeps `microsoft/typescript-go` as a git subtree, then builds a
small wasm command from inside that subtree. Building from inside the upstream Go
module lets the command legally import `typescript-go/internal/...` without
patching upstream compiler packages.

The current API compiles one in-memory TypeScript file, `/input.ts` by default,
with modern ECMAScript lib definitions and returns diagnostics plus emitted
JavaScript.

`tswasm` is published as an alpha. The package is useful for experiments,
browser-side tools, Cloudflare Worker prototypes, and performance comparisons,
but the API is intentionally narrow while `typescript-go` is still moving.

## Install

```bash
npm install tswasm
```

## Usage

When the JavaScript file and `tswasm.wasm` asset are served from the same
package location, `createCompiler()` loads the packaged wasm automatically:

```ts
import { createCompiler } from 'tswasm'

const ts = await createCompiler()
const result = ts.compile('const x: number = 123')

console.log(result.success) // true
console.log(result.js) // "const x = 123"

ts.compile('const s: string = 42') // { success: false, diagnostics: [{..., message: "Type 'number' is not assignable to type 'string'.", ...}] }
```

For bundlers and worker runtimes, pass the wasm module or URL explicitly:

```ts
import { createCompiler } from 'tswasm'
import wasm from 'tswasm/tswasm.wasm'

let tsPromise: ReturnType<typeof createCompiler>

function getCompiler() {
  tsPromise ||= createCompiler({ wasm })
  return tsPromise
}

export default {
  async fetch(request: Request) {
    const code = new URL(request.url).searchParams.get('code') || 'const x = 1'
    const ts = await getCompiler()
    return Response.json(ts.compile(code))
  },
}
```

If the runtime serves wasm as a normal static file, compile it yourself and pass
the `WebAssembly.Module`:

```ts
import { createCompiler } from 'tswasm'

const bytes = await fetch('/tswasm.wasm').then(response => response.arrayBuffer())
const wasm = await WebAssembly.compile(bytes)
const ts = await createCompiler({ wasm })
```

## Current Limits

- Compiles one in-memory input file per call. Pass `fileName` when diagnostics
  should use a path other than `/input.ts`.
- Uses bundled `lib.es2024.d.ts` files, `strict: true`, `target: ES2024`, and
  `module: ESNext`.
- Does not load a `tsconfig.json`, file graph, package dependencies, or custom
  declaration files yet.
- Has no disposal API. Reusing one `createCompiler()` result is cheaper than
  repeatedly creating new runtimes.
- Ships a large wasm payload: about 29 MiB raw and about 6.8 MiB compressed in
  the current package.

## Why

If a compiler needs to run in a browser, Cloudflare Worker, or another
JavaScript runtime where native subprocesses are not available, the practical
implementation choices are JavaScript or WebAssembly. Native `tsgo` is the
obvious choice when native code is allowed, but it does not cover those
environments.

That matters because TypeScript is moving toward the native compiler and
language service for TypeScript 7.0. The TypeScript team describes the native
port as a way to improve raw performance, memory use, and parallelism:
<https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/>.
TypeScript 6.0 is also explicitly a transition release for TypeScript 7.0:
<https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html>.
Microsoft says the existing JavaScript/TypeScript implementation will be
maintained for the foreseeable future, but that the eventual intent is to
develop only the native codebase:
<https://github.com/microsoft/typescript-go/discussions/454>.

`tswasm` explores the practical middle ground: keep the supported native
compiler path available in wasm-capable environments, and measure whether that
path is also faster than the JavaScript compiler APIs those environments can
use today.

## Size

This repo includes a size report for the current package contents:

```bash
pnpm size
```

The script builds `tswasm`, runs `npm pack --dry-run --json`, rejects
benchmark-only native binaries if they would be packed, and prints raw,
gzip, and brotli sizes for the runtime assets. The local JS compiler reference
rows are direct local package/file sizes, not full browser bundle graphs.

Representative local run on 2026-06-19:

### Packed Package

| Package | packed tarball | unpacked install | files |
|---|---:|---:|---:|
| tswasm@0.1.0-alpha.0 | 6.84 MiB | 29.05 MiB | 10 |

### Runtime Assets

| Asset | raw | gzip | brotli |
|---|---:|---:|---:|
| API JS | 4.17 KiB | 1.45 KiB | 1.25 KiB |
| Types | 1.19 KiB | 490 B | 397 B |
| Go wasm runtime JS | 16.93 KiB | 4.40 KiB | 3.79 KiB |
| TypeScript Go wasm | 28.96 MiB | 6.81 MiB | 5.15 MiB |
| Runtime payload total | 28.98 MiB | 6.82 MiB | 5.16 MiB |

### Local JS Compiler References

| Reference | raw/install | gzip | brotli |
|---|---:|---:|---:|
| TypeScript JS compiler file | 8.69 MiB | 1.56 MiB | 1.10 MiB |
| TypeScript JS package | 22.53 MiB | - | - |
| ts-morph bundled JS | 932.10 KiB | 127.57 KiB | 97.12 KiB |
| ts-morph package | 1.41 MiB | - | - |

## Performance

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

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

## Release Checks

```bash
pnpm run release:check
```

The release check builds the wasm and JavaScript output, runs the default Vitest
suite, prints the package size report, and runs `npm pack --dry-run --json`.
That default suite includes the Node and Miniflare Worker tests. Run these
additional environment checks before claiming browser or Expo web support for a
release:

```bash
pnpm test:browser
pnpm test:expo
```
