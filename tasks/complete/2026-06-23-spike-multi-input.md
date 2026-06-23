---
status: complete
size: medium
---

# Spike Multi-Input Compilation

Status summary: Complete. The spike adds a backward-compatible virtual project API, resolves relative imports across in-memory files, returns emitted JavaScript by output file name, parses virtual `tsconfig.json`, documents the behavior, and passes the local release check.

- [x] Add a multi-input compile API while keeping `compile(string)` and `compile({ code, fileName })` working. _Implemented in `src/index.ts`; objects without a string `code` property are forwarded as `{ files }` virtual projects._
- [x] Resolve relative imports between in-memory files. _Implemented in `go/tswasm-wasm/main.go` through the existing inline VFS and TypeScript Go program creation._
- [x] Return emitted JavaScript for every emitted source file. _Implemented as `CompileResult.outputs`; single-file calls still populate `result.js`._
- [x] Support an optional virtual `tsconfig.json`. _Implemented by parsing `/tsconfig.json` from the source-file map with `tsoptions.ParseJsonSourceFileConfigFileContent`; no host config discovery was added._
- [x] Keep default compiler behavior unchanged without a virtual config. _Implemented via `defaultCompilerOptions()` and `applyCompilerDefaults()`; no-config projects keep bundled ES2024 libs, `strict`, ES2024 target, ESNext module, and no source maps/declarations._
- [x] Document the API and limits. _Implemented in `README.md` with file-map and virtual `tsconfig.json` examples plus updated current limits._
- [x] Cover the spike with integration-style tests. _Implemented in `test/compile.test.ts` for single-file compatibility, relative imports, virtual config emit changes, and per-file diagnostics._

## Decisions

- A direct file-map object is the spike API because it matches the prompt and keeps simple browser/worker callers from constructing a larger request object.
- A file-map object with a string `code` property remains ambiguous with the existing single-file request. For backward compatibility, `code` continues to mean the single-file request shape; callers that need a real file named `code` can use `./code.ts` or another path.
- `tsconfig.json` support means "parse a config file supplied in the virtual file map." It does not mean discovering or reading `tsconfig.json` from the runtime filesystem.
- The first implementation should avoid hand-parsing compiler options. TypeScript Go already exposes `tsoptions.ParseJsonSourceFileConfigFileContent`, which can parse config JSON against a virtual filesystem.
- This is a spike, but the branch should still leave the public types, README, and tests coherent enough for review.

## Open Questions

- Should the final public API prefer this direct file-map shape, or should it eventually move to an explicit `compileProject({ files, configFileName })` method to avoid object-shape ambiguity?
- Should `result.js` be empty, the first emitted output, or omitted from multi-input results in a later breaking API revision? For the spike, keep `js` for single-input compatibility and add an output map.

## Implementation Notes

- 2026-06-23: Used `grill-with-docs` repo exploration to check current API, README limits, Go wasm compile wrapper, inline VFS, and upstream TypeScript Go config parser.
- 2026-06-23: Created branch/worktree `spike/multi-input` at `../worktrees/tswasm/spike-multi-input`; committed this task spec first in `6ecf51278`.
- 2026-06-23: Added `CONTEXT.md` terms for **Virtual project**, **Source-file map**, and **Virtual config** so future work does not confuse virtual `tsconfig.json` parsing with host filesystem discovery.
- 2026-06-23: Verified `pnpm exec vitest run test/compile.test.ts`, `pnpm test`, and `pnpm run release:check`.
