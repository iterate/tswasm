import { expect, test } from "vitest";

import { createCompiler } from "../dist/index.js";

test("compiles an in-memory TypeScript string with native tsgo wasm", async () => {
  const compiler = await createCompiler();
  const result = compiler.compile(`
    async function value(input: Iterable<number>): Promise<number[]> {
      const doubled = Array.from(input, item => item * 2).toSorted((a, b) => a - b);
      const values = new Map<number, Promise<number>>();
      values.set(doubled.length, Promise.resolve(doubled.at(-1) || 0));
      return Promise.all(values.values());
    }
  `);

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    compiler: {
      name: "typescript-go (tsgo)",
      runtime: "Go wasm",
      mode: "single in-memory /input.ts",
      lib: "bundled TypeScript lib.es2024.d.ts",
    },
  });
  expect(result.js).toContain("/* tswasm: typescript-go wasm emitted this file */");
  expect(result.js).toContain("async function value");
});

test("returns TypeScript diagnostics", async () => {
  const compiler = await createCompiler();
  const result = compiler.compile(`const value: number = "nope";`);

  expect(result).toMatchObject({
    success: false,
    diagnostics: [
      {
        code: 2322,
        category: "error",
        line: 1,
        column: 6,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });
});
