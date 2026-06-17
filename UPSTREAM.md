# Upstream

`typescript-go/` is imported as a git subtree from:

https://github.com/microsoft/typescript-go

The local package does not patch upstream compiler packages. Instead,
`scripts/build-wasm.ts` overlays `go/tswasm-wasm` into
`typescript-go/cmd/tswasm-wasm` at build time and builds from inside the
upstream module tree. That placement lets the command import
`github.com/microsoft/typescript-go/internal/...` legally under Go's `internal`
package rules.

To update the subtree later:

```bash
git subtree pull --prefix=typescript-go https://github.com/microsoft/typescript-go.git main --squash
```
