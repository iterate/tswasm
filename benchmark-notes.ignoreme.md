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
- Later profile-only row `tswasm native helper compile (same Go path)` measured
  the same one-file compile shape inside native Go at roughly 5ms for both
  snippets. That is much faster than Go wasm's roughly 25-28ms warm compile, so
  native-vs-wasm execution is a major factor.

Interpretation: reducing JSON boundary crossings is unlikely to be the main
performance win for the current one-shot API. The large fixed costs are program
construction and compiler work inside Go wasm.

## 2026-06-18 cache pass

Implemented a safe standard-library string cache in `go/tswasm-wasm/main.go`:

- embedded lib files are read/stringified once per wasm runtime;
- each compile still receives a fresh map and file-name slice so programs do not
  share mutable file collections;
- profile result after the change dropped `tswasm standard libs only` from about
  0.38ms to about 0.03-0.05ms;
- the subsequent full run was cleaner than the original baseline, but the
  profile rows still show the direct cache win is sub-ms and not the dominant
  cost.

I checked the upstream compiler host path. `compiler.NewCompilerHost` reparses
source text on demand; `internal/project` has a parse-cache host, but reusing
parsed source files across one-shot programs is a larger design change because
source-file identity and program/binder/checker mutation need to be understood.
Do not do that as a casual micro-optimization.

Full post-cache command:

```bash
pnpm exec tsx bench/compile.bench.ts --json=tasks/compiler-benchmarks-results-after-cache.ignoreme.json
```

Representative post-cache full run:

- simple `tswasm warm compile`: 28.90ms mean, versus `tsgo native CLI
  (process+files)` at 27.73ms;
- type-heavy `tswasm warm compile`: 24.21ms mean, versus `tsgo native CLI
  (process+files)` at 28.64ms;
- simple `tswasm cold createCompiler+compile`: 60.51ms mean;
- type-heavy `tswasm cold createCompiler+compile`: 56.63ms mean.

## 2026-06-18 same-path native helper

Added `go/tswasm-native-bench/main.go` as a benchmark-only native helper. The
runner copies it into `typescript-go/cmd/tswasm-native-bench`, copies the same
embedded libs used by the wasm command, builds it natively, and asks the helper
to time compile iterations inside the Go process.

Quick profile result:

- simple `tswasm native helper compile (same Go path)`: about 5.0ms;
- type-heavy `tswasm native helper compile (same Go path)`: about 4.9ms;
- simple Go wasm warm compile in the same run: about 27.8ms;
- type-heavy Go wasm warm compile in the same run: about 26.6ms.

Interpretation: the wasm path is not slower because of JS/Go boundary chatter.
For these snippets, Go wasm execution itself is roughly 5x slower than the same
one-file compiler path built as native Go.
