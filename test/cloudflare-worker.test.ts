import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Miniflare } from "miniflare";
import { expect, test } from "vitest";

import { ensureBuilt, packageRoot } from "./fixtures/ensure-built.js";

test("createCompiler works in a Miniflare Worker", async () => {
  await using fixture = await createMiniflareFixture(`
    import { createCompiler } from "./runtime/index.js";
    import wasm from "./runtime/tswasm.wasm";

    let tsPromise;

    function getCompiler() {
      tsPromise ||= createCompiler({ wasm });
      return tsPromise;
    }

    export default {
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/compile") {
          return new Response("not found", { status: 404 });
        }

        const ts = await getCompiler();
        return Response.json(ts.compile(url.searchParams.get("code") || "const x: number = 123"));
      },
    };
  `);

  expect(await fixture.fetchJson(compilePath("const x: number = 123"))).toMatchObject({
    success: true,
    diagnostics: [],
    js: expect.stringContaining("const x = 123;"),
  });

  expect(await fixture.fetchJson(compilePath('const value: number = "nope";'))).toMatchObject({
    success: false,
    js: expect.stringContaining('const value = "nope";'),
    diagnostics: [
      {
        code: 2322,
        category: "error",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });
});

test("createCompiler works inside a Miniflare Durable Object", async () => {
  await using fixture = await createMiniflareFixture(
    `
      import { createCompiler } from "./runtime/index.js";
      import wasm from "./runtime/tswasm.wasm";

      let compilerCreateCount = 0;

      export class CompilerObject {
        constructor(state) {
          this.state = state;
          compilerCreateCount += 1;
          this.tsPromise = createCompiler({ wasm });
        }

        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/stats") {
            return Response.json({
              compileCount: (await this.state.storage.get("compileCount")) || 0,
              compilerCreateCount,
            });
          }

          if (url.pathname !== "/compile") {
            return new Response("not found", { status: 404 });
          }

          const compileCount = ((await this.state.storage.get("compileCount")) || 0) + 1;
          await this.state.storage.put("compileCount", compileCount);

          const ts = await this.tsPromise;
          return Response.json(ts.compile(url.searchParams.get("code") || "const x: number = 123"));
        }
      }

      export default {
        fetch(request, env) {
          const id = env.COMPILER_OBJECT.idFromName("fixture");
          return env.COMPILER_OBJECT.get(id).fetch(request);
        },
      };
    `,
    {
      durableObjects: {
        COMPILER_OBJECT: {
          className: "CompilerObject",
        },
      },
    },
  );

  expect(await fixture.fetchJson("/stats")).toMatchObject({
    compileCount: 0,
    compilerCreateCount: 1,
  });

  expect(await fixture.fetchJson(compilePath("const x: number = 123"))).toMatchObject({
    success: true,
    diagnostics: [],
    js: expect.stringContaining("const x = 123;"),
  });

  expect(await fixture.fetchJson(compilePath('const value: number = "nope";'))).toMatchObject({
    success: false,
    js: expect.stringContaining('const value = "nope";'),
    diagnostics: [
      {
        code: 2322,
        category: "error",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });

  expect(await fixture.fetchJson("/stats")).toMatchObject({
    compileCount: 2,
    compilerCreateCount: 1,
  });
});

async function createMiniflareFixture(
  workerSource: string,
  options: {
    durableObjects?: Record<string, { className: string; useSQLite?: boolean }>;
  } = {},
) {
  await ensureBuilt();

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tswasm-miniflare-"));
  await fs.cp(path.join(packageRoot, "dist"), path.join(tempDir, "runtime"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "worker.js"), `${workerSource}\n`);

  const miniflare = new Miniflare({
    rootPath: tempDir,
    modulesRoot: tempDir,
    scriptPath: "worker.js",
    modules: true,
    modulesRules: [
      { type: "CompiledWasm", include: ["**/*.wasm"] },
      { type: "ESModule", include: ["**/*.js"] },
    ],
    durableObjects: options.durableObjects,
  });

  await miniflare.ready;
  const worker = (await miniflare.getWorker()) as unknown as WorkerFetcherLike;

  return {
    async fetch(input: string, init?: RequestInit) {
      const url = input.startsWith("http://") ? input : `http://fixture${input}`;
      return worker.fetch(url, init);
    },
    async fetchJson(input: string, init?: RequestInit) {
      const response = await this.fetch(input, init);
      if (!response.ok) {
        throw new Error(`fixture returned ${response.status}: ${await response.text()}`);
      }
      return response.json();
    },
    async [Symbol.asyncDispose]() {
      await miniflare.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

interface WorkerFetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

function compilePath(code: string): string {
  return `/compile?${new URLSearchParams({ code })}`;
}
