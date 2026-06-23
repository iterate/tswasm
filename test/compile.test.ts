import { expect, test } from "vitest";

import { createCompiler } from "../dist/index.js";

test("compiles an in-memory TypeScript string with native tsgo wasm", async () => {
  const ts = await createCompiler();
  const result = ts.compile(`
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
      mode: "in-memory virtual TypeScript project",
      lib: "bundled TypeScript lib.es2024.d.ts",
    },
  });
  expect(result.outputs).toMatchObject({
    "input.js": result.js,
  });
  expect(result.js).toMatchInlineSnapshot(`
    ""use strict";
    async function value(input) {
        const doubled = Array.from(input, item => item * 2).toSorted((a, b) => a - b);
        const values = new Map();
        values.set(doubled.length, Promise.resolve(doubled.at(-1) || 0));
        return Promise.all(values.values());
    }
    "
  `);
});

test("returns TypeScript diagnostics", async () => {
  const ts = await createCompiler();
  const result = ts.compile(`const value: number = "nope";`);

  expect(result).toMatchObject({
    success: false,
    js: expect.any(String),
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
  expect(result.js).toMatchInlineSnapshot(`
    ""use strict";
    const value = "nope";
    "
  `);
});

test("compiles a virtual TypeScript project with relative imports", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    files: {
      "src/a.ts": "export const aa = 1;",
      "src/b.ts": "import { aa } from './a';\n\nexport const bb = aa + 0.5;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    js: "",
    outputs: {
      "src/a.js": expect.stringContaining("export const aa = 1;"),
      "src/b.js": expect.stringContaining("export const bb = aa + 0.5;"),
    },
  });
});

test("parses a virtual tsconfig for a project request", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    tsconfig: JSON.stringify({
      compilerOptions: {
        module: "CommonJS",
      },
      files: ["src/index.ts"],
    }),
    files: {
      "src/value.ts": "export const value = 41;",
      "src/index.ts": "import { value } from './value';\n\nexport const answer = value + 1;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    js: "",
    outputs: {
      "src/value.js": expect.stringContaining("exports.value = 41;"),
      "src/index.js": expect.stringContaining('require("./value")'),
    },
  });
});

test("reports file names for virtual project diagnostics", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    files: {
      "src/a.ts": `export const value: number = "nope";`,
      "src/b.ts": "import { value } from './a';\n\nvalue.toFixed();",
    },
  });

  expect(result).toMatchObject({
    success: false,
    diagnostics: [
      {
        code: 2322,
        category: "error",
        fileName: "src/a.ts",
        line: 1,
        column: 13,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });
});

test("uses cwd for virtual project paths and output names", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/project",
    tsconfig: JSON.stringify({
      files: ["src/index.ts"],
    }),
    files: {
      "src/index.ts": "export const value = 123;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/index.js": expect.stringContaining("export const value = 123;"),
    },
  });
});

test("resolves virtual node_modules package types", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    tsconfig: JSON.stringify({
      compilerOptions: {
        moduleResolution: "Bundler",
      },
      files: ["src/index.ts"],
    }),
    files: {
      "src/index.ts": "import { external } from 'pkg';\n\nexport const value = external + 1;",
      "node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        types: "index.d.ts",
      }),
      "node_modules/pkg/index.d.ts": "export const external: number;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/index.js": expect.stringContaining("export const value = external + 1;"),
    },
  });
  expect(result.outputs).not.toHaveProperty("node_modules/pkg/index.js");
});

test("uses default virtual node_modules at-types roots from cwd", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    tsconfig: JSON.stringify({
      compilerOptions: {
        types: ["custom"],
      },
      files: ["src/index.ts"],
    }),
    files: {
      "src/index.ts": "export const value = typedValue;",
      "node_modules/@types/custom/index.d.ts": "declare const typedValue: number;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/index.js": expect.stringContaining("export const value = typedValue;"),
    },
  });
});

test("uses explicit project typeRoots as a virtual filesystem override", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    typeRoots: ["types"],
    tsconfig: JSON.stringify({
      compilerOptions: {
        types: ["custom"],
      },
      files: ["src/index.ts"],
    }),
    files: {
      "src/index.ts": "export const value = typedValue;",
      "types/custom/index.d.ts": "declare const typedValue: number;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/index.js": expect.stringContaining("export const value = typedValue;"),
    },
  });
});
