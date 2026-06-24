---
status: complete
size: medium
---

# Spike Multi-Input Compilation

Status summary: Complete. The spike adds a virtual project API with string shorthand, resolves relative imports across in-memory files, returns emitted JavaScript by output file name, supports entrypoint-selected `result.js`, supports tsc-like virtual `tsconfig.json` selection, supports virtual `cwd`, documents the behavior, and passes the local release check.

- [x] Add a multi-input compile API while keeping `compile(string)` as shorthand. _Implemented in `src/index.ts` as explicit project requests: `compile({ files, entrypoint, tsconfig, cwd })`; the removed `{ code, fileName }` object shape now fails if called dynamically._
- [x] Resolve relative imports between in-memory files. _Implemented in `go/tswasm-wasm/main.go` through the existing inline VFS and TypeScript Go program creation._
- [x] Return emitted JavaScript for every emitted source file. _Implemented as `CompileResult.outputs`, including `.js`, `.mjs`, and `.cjs`; `entrypoint` selects which emitted output also populates `result.js`._
- [x] Support an optional virtual `tsconfig`. _Implemented by parsing the named config file from the project `files` map with `tsoptions.ParseJsonSourceFileConfigFileContent`; omitted `tsconfig` uses virtual `tsconfig.json` at `cwd` when present, and no host config discovery was added._
- [x] Keep default compiler behavior unchanged without a virtual config. _Implemented via `defaultCompilerOptions()` and `applyCompilerDefaults()`; no-config projects keep bundled ES2024 libs, `strict`, ES2024 target, ESNext module, and no source maps/declarations._
- [x] Document the API and limits. _Implemented in `README.md` with project request, virtual `tsconfig`, virtual `node_modules`, and config `typeRoots` examples plus updated current limits._
- [x] Cover the spike with integration-style tests. _Implemented in `test/compile.test.ts` for single-file compatibility, relative imports, virtual config emit changes, per-file diagnostics, virtual `cwd`, package types, default `node_modules/@types`, and config `typeRoots`._

## Decisions

- The project API is explicit: `compile({ files, entrypoint, tsconfig, cwd })`. This avoids the `code` filename ambiguity from a bare file-map overload and leaves room for project-level options.
- `compile(string)` is only a shorthand for a generated project request with `entrypoint: "index.ts"`, not a separate `{ code, fileName }` object API.
- `tsconfig` support means "parse a config file named by the project request from the virtual `files` map, or use virtual `tsconfig.json` at `cwd` when `tsconfig` is omitted." It does not mean discovering or reading `tsconfig.json` from the runtime filesystem.
- `typeRoots` belongs in virtual `tsconfig`. When it is not set, TypeScript Go derives default `node_modules/@types` roots from the virtual `cwd`/config path.
- The first implementation should avoid hand-parsing compiler options. TypeScript Go already exposes `tsoptions.ParseJsonSourceFileConfigFileContent`, which can parse config JSON against a virtual filesystem.
- This is a spike, but the branch should still leave the public types, README, and tests coherent enough for review.

## Implementation Notes

- 2026-06-23: Used `grill-with-docs` repo exploration to check current API, README limits, Go wasm compile wrapper, inline VFS, and upstream TypeScript Go config parser.
- 2026-06-23: Created branch/worktree `spike/multi-input` at `../worktrees/tswasm/spike-multi-input`; committed this task spec first in `6ecf51278`.
- 2026-06-23: Added `CONTEXT.md` terms for **Virtual project**, **Source-file map**, and **Virtual config** so future work does not confuse virtual `tsconfig.json` parsing with host filesystem discovery.
- 2026-06-23: Verified `pnpm exec vitest run test/compile.test.ts`, `pnpm test`, and `pnpm run release:check`.
- 2026-06-23: Replaced the initial bare file-map overload with `compile({ files, tsconfig, cwd })` after API review; type root control stays in virtual `tsconfig` while default type discovery comes from TypeScript Go's virtual `node_modules/@types` resolution.
- 2026-06-23: Corrected `tsconfig` to be a virtual file path such as `tsconfig.lib.json`, not JSON content; the config file contents live in `files`.
- 2026-06-24: Removed the top-level `typeRoots` option because it duplicated `compilerOptions.typeRoots` and created unnecessary precedence questions.
- 2026-06-24: Documented and tested the intentional tsc-like virtual `tsconfig.json` default, while keeping the boundary that only files supplied in the source-file map can participate.
- 2026-06-24: Preserved `.mjs` and `.cjs` JavaScript emit outputs from `.mts` and `.cts` sources.
- 2026-06-24: Removed the `{ code, fileName }` object API before release and added `entrypoint` so project requests can select the emitted file mirrored into `result.js`.
