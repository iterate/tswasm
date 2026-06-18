# Benchmark Follow-up Notes

## Why `tsgo native CLI` can look faster than `tswasm warm compile`

1. `tswasm warm compile` is only warm at the wasm-runtime level. Each compile
   still reloads bundled lib files, builds a fresh in-memory file map, creates a
   compiler host/program, checks, and emits.

2. The wasm path currently pays a JS-to-Go-wasm boundary cost on every compile:
   JS `JSON.stringify` -> Go wasm function call/string transfer -> Go
   `json.Unmarshal` -> compiler work -> Go `json.Marshal` -> JS `JSON.parse`.

3. The wasm compiler is forced single-threaded. Native `tsgo` may benefit from
   native Go runtime/codegen behavior that Go wasm does not get.

4. The benchmark's native CLI row does less timed setup than its name might
   imply. The temp source file and `tsconfig.json` are written once when the
   runner is created; each timed sample removes `out/` and spawns `tsgo`.

5. OS file cache can make native CLI file reads cheap, while Go wasm
   string/memory/JSON work is still paid directly inside the process.

## Why the boundary cost is paid every call

The public JS API accepts a normal JS object or string and returns a normal JS
object. The current wasm export is a single JS global function,
`__tswasmCompile`, whose argument and return value are JSON strings. That means
every compile has to serialize the request before crossing into Go wasm and
deserialize the response after crossing back.

On the JS side:

- `compiler.compile({ code, fileName })` normalizes the input.
- `JSON.stringify(request)` allocates and encodes the source text into a JSON
  string.
- `nativeCompile(...)` calls the Go wasm callback.
- `JSON.parse(...)` allocates the result object and decodes emitted JS plus
  diagnostics.

On the Go wasm side:

- the callback receives a JS string value from `syscall/js`;
- `args[0].String()` copies/decodes it into a Go string;
- `json.Unmarshal` allocates a Go request struct and source string;
- after compilation, `json.Marshal` allocates a JSON response string containing
  emitted JS and diagnostics;
- returning the string crosses back through `syscall/js`.

So even if the wasm runtime is already booted, the request/response protocol is
still fully rebuilt for each call. The largest pieces are likely source-text
copying and JSON encode/decode, especially once emitted JS or diagnostics get
large.

## Possible follow-up measurements

- Add a `tswasm boundary only` row that calls a trivial wasm function returning a
  fixed JSON response. Done as `tswasm JSON round trip (no compile)`.
- Add a `tswasm parse request only` row in Go if the entrypoint can expose a
  debug mode.
- Compare JSON protocol with a handle-based API where JS registers source text
  once and subsequent calls pass a small numeric/string handle.
- Try preloading/caching standard library source strings inside the Go runtime
  so warm compile does not rebuild them every call.
- Add a native `@typescript/native-preview` in-process row to separate native
  compiler speed from `tsgo` subprocess overhead.
- Add a spawn-only row such as `tsgo --version` to quantify subprocess startup
  on this machine. Done as `tsgo native CLI --version (spawn only)`.

## 2026-06-18 profile snapshot

Command:

```bash
pnpm exec tsx bench/compile.bench.ts --quick --include-internals --json=tasks/compiler-benchmarks-profile.ignoreme.json
```

Observed on Apple M4 Max / Node v26.0.0:

- `tswasm JSON round trip (no compile)`: roughly 0.018ms simple and 0.036ms
  type-heavy. Boundary plus JSON protocol is visible but tiny relative to
  compile time.
- `tswasm standard libs only`: roughly 0.38-0.39ms. Rebuilding the lib map is
  not the main cost for these snippets, though caching it is still cheap and
  sensible.
- `tswasm program setup only`: roughly 14-15ms. Creating the program/host/source
  structure is a major fixed cost.
- `tswasm emit only`: roughly 23-24ms.
- `tswasm diagnostics only`: roughly 27-32ms in the quick run, noisy but in the
  same ballpark as full warm compile.
- `tsgo native CLI --version (spawn only)`: roughly 9.8ms. Subprocess startup is
  material, but not enough to explain the whole tsgo-vs-tswasm relationship.

Interpretation: reducing JSON boundary crossings is unlikely to be the main
performance win for the current one-shot API. The large fixed costs are program
construction and compiler work inside Go wasm.
