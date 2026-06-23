# tswasm

`tswasm` exposes TypeScript Go compilation to JavaScript runtimes through a
packaged wasm compiler.

## Language

**Virtual project**:
An in-memory TypeScript project whose files are supplied by the caller for one compile call.
_Avoid_: File graph, package, workspace

**Source-file map**:
An object mapping virtual file names to source text for a **Virtual project**.
_Avoid_: Filesystem, project directory

**Virtual config**:
A `tsconfig.json` supplied inside the **Source-file map** and parsed from memory.
_Avoid_: Host config, discovered config

**Single-file request**:
The backward-compatible compile input that contains one TypeScript source string and an optional virtual file name.
_Avoid_: Project request

## Relationships

- A **Virtual project** is described by exactly one **Source-file map**.
- A **Source-file map** may contain one **Virtual config** at `tsconfig.json`.
- A **Single-file request** is not a **Virtual project**, even though both compile through the same wasm runtime.

## Example dialogue

> **Dev:** "Should a `tsconfig.json` next to the app be loaded when we compile a source-file map?"
> **Domain expert:** "No. Only a **Virtual config** in the **Source-file map** participates in compilation."

## Flagged ambiguities

- "multi-input" now means a **Virtual project** supplied as a **Source-file map**, not runtime access to host files or package dependencies.
- "`tsconfig.json` support" now means **Virtual config** parsing, not host config discovery.
