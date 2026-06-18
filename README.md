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

## Upstream Layout

- `typescript-go/` is a git subtree of `microsoft/typescript-go`.
- `go/tswasm-wasm/` is this package's wasm command source.
- `scripts/build-wasm.ts` overlays the command into
  `typescript-go/cmd/tswasm-wasm`, copies the needed lib definition files, and
  builds `dist/tswasm.wasm`.

That keeps the public package separate from upstream while still allowing the Go
entrypoint to reach tsgo's current internal compiler APIs.
