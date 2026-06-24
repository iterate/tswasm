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
    "index.js": result.js,
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
    entrypoint: "src/b.ts",
    files: {
      "src/a.ts": "export const aa = 1;",
      "src/b.ts": "import { aa } from './a';\n\nexport const bb = aa + 0.5;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/a.js": expect.stringContaining("export const aa = 1;"),
      "src/b.js": expect.stringContaining("export const bb = aa + 0.5;"),
    },
  });
  expect(result.js).toBe(result.outputs["src/b.js"]);
});

test("parses a virtual tsconfig for a project request", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    entrypoint: "src/index.ts",
    tsconfig: "tsconfig.lib.json",
    files: {
      "tsconfig.lib.json": JSON.stringify({
        compilerOptions: {
          module: "CommonJS",
          outDir: "dist",
          rootDir: "src",
        },
        files: ["src/index.ts"],
      }),
      "src/value.ts": "export const value = 41;",
      "src/index.ts": "import { value } from './value';\n\nexport const answer = value + 1;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "dist/value.js": expect.stringContaining("exports.value = 41;"),
      "dist/index.js": expect.stringContaining('require("./value")'),
    },
  });
  expect(result.js).toBe(result.outputs["dist/index.js"]);
});

test("auto-selects virtual tsconfig.json when tsconfig is omitted", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    entrypoint: "src/selected.ts",
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "CommonJS",
        },
        files: ["src/selected.ts"],
      }),
      "src/index.ts": "export const index = 1;",
      "src/selected.ts": "export const selected = 2;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/selected.js": expect.stringContaining("exports.selected = 2;"),
    },
  });
  expect(result.js).toBe(result.outputs["src/selected.js"]);
  expect(result.outputs).not.toHaveProperty("src/index.js");
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
    entrypoint: "src/index.ts",
    tsconfig: "tsconfig.json",
    files: {
      "tsconfig.json": JSON.stringify({
        files: ["src/index.ts"],
      }),
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
  expect(result.js).toBe(result.outputs["src/index.js"]);
});

test("resolves virtual node_modules package types", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    entrypoint: "src/index.ts",
    tsconfig: "tsconfig.json",
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          moduleResolution: "Bundler",
        },
        files: ["src/index.ts"],
      }),
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
  expect(result.js).toBe(result.outputs["src/index.js"]);
  expect(result.outputs).not.toHaveProperty("node_modules/pkg/index.js");
});

test("uses default virtual node_modules at-types roots from cwd", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    entrypoint: "src/index.ts",
    tsconfig: "tsconfig.json",
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          types: ["custom"],
        },
        files: ["src/index.ts"],
      }),
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
  expect(result.js).toBe(result.outputs["src/index.js"]);
});

test("uses virtual tsconfig typeRoots", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    cwd: "/app",
    entrypoint: "src/index.ts",
    tsconfig: "tsconfig.json",
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          typeRoots: ["types"],
          types: ["custom"],
        },
        files: ["src/index.ts"],
      }),
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
  expect(result.js).toBe(result.outputs["src/index.js"]);
});

test("returns emitted mjs and cjs outputs for mts and cts sources", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    entrypoint: "src/module.mts",
    files: {
      "src/module.mts": "export const moduleValue = 1;",
      "src/common.cts": "export const commonValue = 2;",
    },
  });

  expect(result).toMatchObject({
    success: true,
    diagnostics: [],
    outputs: {
      "src/module.mjs": expect.any(String),
      "src/common.cjs": expect.any(String),
    },
  });
  expect(result.outputs["src/module.mjs"]).toContain("moduleValue");
  expect(result.outputs["src/common.cjs"]).toContain("commonValue");
  expect(result.js).toBe(result.outputs["src/module.mjs"]);
});

test("reports a missing virtual tsconfig path", async () => {
  const ts = await createCompiler();
  const result = ts.compile({
    tsconfig: "tsconfig.lib.json",
    files: {
      "src/index.ts": "export const value = 1;",
    },
  });

  expect(result).toMatchObject({
    success: false,
    diagnostics: [
      {
        category: "error",
        message: "compile tsconfig file was not found in files: tsconfig.lib.json",
      },
    ],
  });
});
