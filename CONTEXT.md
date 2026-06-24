# tswasm

`tswasm` exposes TypeScript Go compilation to JavaScript runtimes through a
packaged wasm compiler.

## Language

**Virtual project**:
An in-memory TypeScript project whose files and options are supplied by the caller for one compile call.
_Avoid_: File graph, package, workspace

**Project request**:
The compile input that describes a **Virtual project** with `files`, optional `tsconfig`, and optional `cwd`.
_Avoid_: File map

**Source-file map**:
An object mapping virtual file names to source text for a **Virtual project**.
_Avoid_: Filesystem, project directory

**Virtual config**:
A TypeScript config file supplied in the **Source-file map** and selected by the **Project request** `tsconfig` path.
_Avoid_: Host config, discovered config

**Virtual cwd**:
The current directory used to resolve relative virtual paths and default type roots for a **Project request**.
_Avoid_: Process cwd, host cwd

**Single-file request**:
The backward-compatible compile input that contains one TypeScript source string and an optional virtual file name.
_Avoid_: Project request

## Relationships

- A **Virtual project** is described by exactly one **Project request**.
- A **Project request** contains exactly one **Source-file map**.
- A **Project request** may select one **Virtual config** by virtual file name.
- A **Project request** may set one **Virtual cwd**.
- A **Single-file request** is not a **Virtual project**, even though both compile through the same wasm runtime.

## Example dialogue

> **Dev:** "Should a `tsconfig.json` next to the app be loaded when we compile a project request?"
> **Domain expert:** "No. Only a **Virtual config** selected by the **Project request** participates in compilation."

## Flagged ambiguities

- "multi-input" now means a **Virtual project** supplied as a **Project request**, not runtime access to host files or package dependencies.
- "`tsconfig.json` support" now means **Virtual config** parsing, not host config discovery.
- "`cwd`" now means **Virtual cwd**, not the JavaScript process current working directory.
