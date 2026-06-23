---
status: in-progress
size: medium
---

# Spike Multi-Input Compilation

Status summary: Spec committed before implementation. The intended spike is a backward-compatible virtual project API that accepts a source-file map, resolves relative imports between those files, returns emitted JavaScript per output file, and optionally parses an in-map `tsconfig.json`. No implementation has started yet.

- [ ] Add a multi-input compile API while keeping `compile(string)` and `compile({ code, fileName })` working. _Planned shape: `compile({ "src/a.ts": "...", "src/b.ts": "..." })` treats an object without `code` as a virtual project file map._
- [ ] Resolve relative imports between in-memory files. _Use the existing inline VFS and TypeScript Go program creation rather than host filesystem reads._
- [ ] Return emitted JavaScript for every emitted source file. _Single-file calls should keep `result.js`; multi-file calls should expose an output map so callers can inspect `src/a.js`, `src/b.js`, etc._
- [ ] Support an optional virtual `tsconfig.json`. _If the file map includes `tsconfig.json`, parse it with the upstream TypeScript Go config parser from the same virtual filesystem; do not read a real host config._
- [ ] Keep default compiler behavior unchanged without a virtual config. _The no-config path should continue using bundled ES2024 libs, `strict: true`, `target: ES2024`, `module: ESNext`, and no source maps or declarations._
- [ ] Document the API and limits. _README should show multi-file usage, explain that `tsconfig.json` is virtual/in-memory, and call out unsupported package dependency loading._
- [ ] Cover the spike with integration-style tests. _Tests should compile imports across files, preserve single-file behavior, and exercise at least one `tsconfig.json` option that changes emit._

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
