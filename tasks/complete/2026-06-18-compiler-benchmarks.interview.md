# Compiler Benchmarks Grill Transcript

## Q1 - Warm Path Boundary - 2026-06-18

**Q1: What should the "warm" path actually measure?**

The `createCompiler()` call is async -- it loads the wasm binary, starts the Go runtime, and waits for `__tswasmCompile` to register. The sync `compile()` call that follows is the hot path. For "warm" benchmarks, the setup has to happen outside the bench loop.

Recommended answer from sub-agent: use a module-level shared compiler created once, then benchmark only `compiler.compile(code)`. Follow-on: decide whether that one compiler is shared across both simple and complex snippet groups or recreated per snippet group.

## A1 - 2026-06-18

Yes, use the shared compiler interpretation for warm.

For tswasm specifically, I want one compiler created once per benchmark process and shared across the warm simple and warm complex source groups. That matches "createCompiler already resolved" most literally, avoids accumulating multiple Go wasm runtimes that the current API cannot dispose, and represents the likely app usage pattern: boot once, compile many snippets.

Comparator warm paths should follow the same spirit: load/import/setup once outside the measured loop, then benchmark the equivalent compile operation. Where a competitor cannot make the same boundary cleanly, label that explicitly instead of forcing symmetry.

[guess: shared across all warm source groups is the maintainer-preferred reading because the prompt described `createCompiler` already resolved, not "resolved for this case".]

---

## Q2 - Scenario Grouping - 2026-06-18

**Q2: How should the two dimensions -- input complexity (simple vs complex) and thermal state (warm vs cold) -- be organized as `describe` groups?**

Recommended answer from sub-agent: group by complexity in one file. Each group has rows for `tswasm warm`, `tswasm cold`, and the comparators, which produces one README table per input kind.

## A2 - 2026-06-18

Yes, group by input/source complexity.

Use one table per source case, and put tool plus benchmark boundary in the row name. That makes the first-order question "how fast is this implementation on this kind of input?" while keeping warm/cold cost visible in the same place.

Preferred shape:

```ts
describe("simple snippet", () => {
  bench("tswasm warm compile", ...)
  bench("tswasm cold createCompiler+compile", ...)
  bench("TypeScript JS full program", ...)
  bench("TypeScript JS transpileModule (emit only)", ...)
  bench("ts-morph full program", ...)
  bench("tsgo native CLI (process+files)", ...)
})

describe("type-heavy snippet", () => {
  // same rows
})
```

If the final runner is a standalone script instead of Vitest `bench()`, keep the same conceptual grouping in the output/docs.

[guess: "type-heavy snippet" is a better second case name than "complex snippet" because it says what makes it complex for TypeScript.]

---

## Q3 - Native TypeScript Comparator - 2026-06-18

**Q3: Should the bench include both a tsgo in-process API row and a tsgo CLI row, or just one?**

Recommended answer from sub-agent: CLI only for the first pass, labelled `tsgo native CLI (process+files)`, because it is the common tool surface and avoids leaning on unstable API details.

## A3 - 2026-06-18

Use CLI only for this pass.

The goal is an honest appraisal, not a perfect abstraction lab. The `tsgo` CLI is the real TypeScript native surface people can run today, and the row name should say exactly what it includes: `tsgo native CLI (process+files)`.

The docs should explicitly say this is not equivalent to tswasm warm in-memory compile. It is still valuable because it answers "how does this compare to the real native compiler tool?" If process startup dominates, that is useful evidence and a reason for a later `@typescript/native-preview` in-process follow-up.

[guess: the maintainer will prefer one clearly labelled native row now over adding unstable API complexity before the first benchmark suite exists.]

---

## Q4 - Source Cases - 2026-06-18

**Q4: What TypeScript code should the two snippets contain?**

Recommended answer from sub-agent: use the existing async compile test as the simple snippet, and use a compact type-heavy snippet with recursive conditional types, mapped types with key remapping, template literal types, and generic inference.

## A4 - 2026-06-18

Use the existing test source as the simple snippet.

For the type-heavy snippet, use the recommended shape but avoid making it a huge synthetic torture test. It should be compact enough to read in the benchmark file and docs, while forcing real type-checker work:

- recursive conditional type such as `Jsonify<T>`
- mapped type with key remapping such as `ListenerMap<T>`
- template literal types such as `on${Capitalize<string & K>}`
- generic inference at `on()` and `emit()` call sites
- a couple of concrete instantiations so the types are actually evaluated

No need for a domain-specific example yet. The point is to cover common expensive type-system constructs, not mimic a whole application.

[guess: compact type-heavy code is preferable to a generated mega-fixture because the user emphasized methodology/readability from schematch.]

---

## Q5 - JavaScript Compiler Comparator Scope - 2026-06-18

**Q5: Do the JS TypeScript and ts-morph comparator rows use an in-memory virtual filesystem, and does each bench iteration include program creation or just emit?**

Recommended answer from sub-agent: use in-memory hosts for `ts.createProgram` and ts-morph; each iteration includes full program/project creation and emit; no warm/cold split for JS comparator rows.

## A5 - 2026-06-18

Yes.

Use an in-memory virtual host for `ts.createProgram` and ts-morph so the old JS compiler rows are as close to tswasm's in-memory shape as those APIs allow. Include full program/project creation inside each timed operation because that is what tswasm's `compile()` currently does internally too.

Do not invent warm/cold names for these rows. Use precise labels instead:

- `TypeScript JS full program (in-memory)`
- `TypeScript JS transpileModule (emit only)`
- `ts-morph full program (in-memory)`

The docs should say `transpileModule` is not typechecking-equivalent and exists as an intentionally favorable emit-only baseline for the JS compiler.

[guess: explicitly including the favorable emit-only baseline matches "capture all aspects, whether favourable or not".]

---

## Final Decision Record

| Decision | Choice |
|---|---|
| Warm | One shared `compiler` per process, created with top-level await; iterations call `compile()` only |
| Cold | Each iteration: `createCompiler() + compile()`; docs note Go instance accumulation |
| Groups | `describe("simple snippet")` and `describe("type-heavy snippet")` |
| JS TS host | In-memory virtual host; full program creation per iteration; no warm/cold split |
| tsgo | CLI subprocess only; no in-process API this pass |
| Snippet: simple | Existing test async function with `Map`, `Array.from`, and `Promise.all` |
| Snippet: type-heavy | Compact `Jsonify<T>` plus `ListenerMap<T>` plus template literal `on${Capitalize<string & K>}` with concrete call-site instantiations |

Row names per group:

- `tswasm warm compile`
- `tswasm cold createCompiler+compile`
- `TypeScript JS full program (in-memory)`
- `TypeScript JS transpileModule (emit only)`
- `ts-morph full program (in-memory)`
- `tsgo native CLI (process+files)`
