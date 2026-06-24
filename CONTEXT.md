# tswasm

`tswasm` exposes TypeScript Go compilation to JavaScript runtimes through a
packaged wasm compiler.

## Language

**Virtual project**:
An in-memory TypeScript project whose files and options are supplied by the caller for one compile call.
_Avoid_: File graph, package, workspace

**Project request**:
The compile input that describes a **Virtual project** with `files`, optional `entrypoint`, optional `tsconfig`, and optional `cwd`.
_Avoid_: File map

**Source-file map**:
An object mapping virtual file names to source text for a **Virtual project**.
_Avoid_: Filesystem, project directory

**Virtual config**:
A TypeScript config file supplied in the **Source-file map** and selected by the **Project request** `tsconfig` path or the default virtual `tsconfig.json` lookup.
_Avoid_: Host config, discovered config

**Virtual cwd**:
The current directory used to resolve relative virtual paths and default type roots for a **Project request**.
_Avoid_: Process cwd, host cwd

**Entrypoint**:
The virtual source path whose emitted JavaScript is copied into `CompileResult.js`.
_Avoid_: Main file, target file

**String shorthand**:
The compile input that contains one TypeScript source string and is normalized to a **Project request** with `entrypoint: "index.ts"`.
_Avoid_: Project request

## Relationships

- A **Virtual project** is described by exactly one **Project request**.
- A **Project request** contains exactly one **Source-file map**.
- A **Project request** may set one **Entrypoint**.
- A **Project request** may select one **Virtual config** by virtual file name, or use the default `tsconfig.json` at the **Virtual cwd**.
- A **Project request** may set one **Virtual cwd**.
- A **String shorthand** is equivalent to a generated **Project request**.

## Example dialogue

> **Dev:** "Should a `tsconfig.json` next to the app be loaded when we compile a project request?"
> **Domain expert:** "No. Only a **Virtual config** in the **Source-file map** participates in compilation."

## Flagged ambiguities

- "multi-input" now means a **Virtual project** supplied as a **Project request**, not runtime access to host files or package dependencies.
- "`tsconfig.json` support" now means **Virtual config** parsing, not host config discovery.
- "`cwd`" now means **Virtual cwd**, not the JavaScript process current working directory.
