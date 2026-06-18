---
status: complete
size: medium
---

# Compiler Benchmarks

Status summary: Complete. The repo now has a standalone compile benchmark runner, six labelled comparator rows across two source cases, README methodology/results, and verified `bench:quick` plus regular tests.

- [x] Decide benchmark scenario names and comparator labels. _Implemented via grill-you transcript in `tasks/complete/2026-06-18-compiler-benchmarks.interview.md`; final rows are listed below._
- [x] Add benchmark source cases for small/simple and larger/type-heavy snippets. _Implemented in `bench/compile.bench.ts` as `simple snippet` and `type-heavy snippet`._
- [x] Add benchmark implementations for tswasm warm and cold paths. _Implemented in `bench/compile.bench.ts`; warm uses one shared compiler, cold uses fixed samples of `createCompiler()+compile`._
- [x] Add honest comparators for classic TypeScript JS, ts-morph, and native TypeScript. _Implemented in `bench/compile.bench.ts` with `ts.createProgram`, `transpileModule`, ts-morph, and local `tsgo` CLI rows._
- [x] Document how to run benchmarks and how to interpret non-equivalent comparisons. _Implemented in `README.md` with commands, methodology notes, research links, and representative local tables._

## Benchmark Contract

Group results by source case:

- `simple snippet`
- `type-heavy snippet`

Use these row labels in each group:

- `tswasm warm compile`
- `tswasm cold createCompiler+compile`
- `TypeScript JS full program (in-memory)`
- `TypeScript JS transpileModule (emit only)`
- `ts-morph full program (in-memory)`
- `tsgo native CLI (process+files)`

## Source Cases

`simple snippet` should use the existing compile test's self-contained async function with `Map`, `Array.from`, and `Promise.all`.

`type-heavy snippet` should stay compact but force real checker work:

- recursive conditional type such as `Jsonify<T>`
- mapped type with key remapping such as `ListenerMap<T>`
- template literal type such as ``on${Capitalize<string & K>}``
- generic inference at `on()` and `emit()` call sites
- concrete instantiations so the types are evaluated

## Comparator Boundaries

- `tswasm warm compile`: one shared compiler per benchmark process; timed work is only `compiler.compile(code)`.
- `tswasm cold createCompiler+compile`: timed work includes `createCompiler()` and one compile. Docs must note repeated cold samples accumulate Go wasm runtimes because the current public API has no disposal hook.
- `TypeScript JS full program (in-memory)`: timed work includes in-memory host, `ts.createProgram`, diagnostics, and emit.
- `TypeScript JS transpileModule (emit only)`: intentionally favorable JS compiler baseline; not typechecking-equivalent.
- `ts-morph full program (in-memory)`: timed work includes creating an in-memory project/source file, diagnostics, and emit.
- `tsgo native CLI (process+files)`: uses the native TypeScript CLI in a subprocess with temp files; not equivalent to tswasm in-memory warm compile.

## Guesses and Assumptions

- Shared warm compiler across all source groups is the intended reading of "createCompiler already resolved."
- Compact type-heavy source is preferable to generated mega-fixtures because readability/methodology was called out via the schematch reference.
- CLI-only native TypeScript is enough for the first pass; an unstable `@typescript/native-preview` API row can be a follow-up if process startup dominates.
- Including `transpileModule` matches "capture all aspects, whether favourable or not," as long as it is labelled emit-only.

## Implementation Notes

- 2026-06-18: Started grill-you pass with local workspace `/tmp/grillings/tswasm/compiler-benchmarks/`.
- 2026-06-18: Completed grill-you pass. Repo has no remote configured, so no PR was opened.
- 2026-06-18: Added `tinybench` and `ts-morph` dev dependencies.
- 2026-06-18: Added `bench/compile.bench.ts`, `pnpm bench`, and `pnpm bench:quick`.
- 2026-06-18: Ran full benchmark and saved ignored JSON to `tasks/compiler-benchmarks-results.ignoreme.json`.
- 2026-06-18: Verified `pnpm bench:quick` and `pnpm test`.
- 2026-06-18: Verified the standalone benchmark script with `pnpm exec tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2024 --types node --skipLibCheck bench/compile.bench.ts`.
