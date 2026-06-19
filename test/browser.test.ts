import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { expect, test as baseTest } from "vitest";

import { packageRoot } from "./fixtures/ensure-built.js";
import {
  createBrowserRpcFixture,
  type BrowserRpcFixture,
  type RenderedHost,
} from "./fixtures/browser-rpc-fixture.js";

const test = baseTest.skipIf(!process.env.TSWASM_BROWSER_TEST);

declare const createCompiler: typeof import("../dist/index.js").createCompiler;

test("createCompiler works in a real browser", { timeout: 60_000 }, async () => {
  await using fixture = await createTswasmBrowserFixture(
    class BrowserCompileTest {
      tsPromise = createCompiler();

      async compile(code: string) {
        return (await this.tsPromise).compile(code);
      }
    },
  );

  expect(await fixture.stub.compile("const x: number = 123")).toMatchObject({
    success: true,
    diagnostics: [],
    js: expect.stringContaining("const x = 123;"),
  });

  expect(await fixture.stub.compile('const value: number = "nope";')).toMatchObject({
    success: false,
    diagnostics: [
      {
        code: 2322,
        category: "error",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ],
  });
});

function createTswasmBrowserFixture<TInstance extends object>(
  classDef: new (...args: any[]) => TInstance,
): Promise<BrowserRpcFixture<TInstance>> {
  return createBrowserRpcFixture({
    classDef,
    async renderHost({ root, port, classDefString, className, methodNames }): Promise<RenderedHost> {
      await fs.cp(path.join(packageRoot, "dist"), path.join(root, "runtime"), { recursive: true });

      await fs.writeFile(
        path.join(root, "entry.js"),
        `
          import { createCompiler } from "./runtime/index.js";

          ${classDefString}

          const methodNames = ${JSON.stringify(methodNames)};
          let fixturePromise;

          function bootFixture() {
            if (!fixturePromise) {
              fixturePromise = Promise.resolve(new ${className}());
            }
            return fixturePromise;
          }

          function el(testId) {
            return document.querySelector(\`[data-testid="\${testId}"]\`);
          }

          function setText(testId, text) {
            const node = el(testId);
            if (node) node.textContent = text;
          }

          function render() {
            document.body.innerHTML = \`
              <div data-testid="boot-status">booting</div>
              <div data-testid="boot-error"></div>
              <div data-testid="rpc-request-id">0</div>
              <div data-testid="rpc-status">idle</div>
              <div data-testid="rpc-result"></div>
              <div data-testid="rpc-error"></div>
              \` + methodNames.map((method) => \`
                <div>
                  <input data-testid="rpc-input-\${method}" value="[]" />
                  <button data-testid="rpc-\${method}">\${method}</button>
                </div>
              \`).join("");

            let requestId = 0;
            for (const method of methodNames) {
              const button = el(\`rpc-\${method}\`);
              button.addEventListener("click", async () => {
                const nextRequestId = ++requestId;
                const input = el(\`rpc-input-\${method}\`);
                setText("rpc-request-id", String(nextRequestId));
                setText("rpc-status", "running");
                setText("rpc-result", "");
                setText("rpc-error", "");
                try {
                  const parsed = JSON.parse(input.value);
                  if (!Array.isArray(parsed)) {
                    throw new Error("Method args must be a JSON array");
                  }
                  const fixture = await bootFixture();
                  const value = await fixture[method](...parsed);
                  setText("rpc-result", JSON.stringify({ requestId: nextRequestId, value }));
                  setText("rpc-status", "success");
                } catch (error) {
                  setText("rpc-error", JSON.stringify({ requestId: nextRequestId, message: String(error) }));
                  setText("rpc-status", "error");
                }
              });
            }
          }

          render();
          bootFixture().then(
            () => setText("boot-status", "ready"),
            (error) => {
              setText("boot-status", "error");
              setText("boot-error", String(error));
            },
          );
        `,
      );

      await fs.writeFile(
        path.join(root, "index.html"),
        `
          <!doctype html>
          <html>
            <head><meta charset="utf-8"><title>tswasm browser fixture</title></head>
            <body>
              <script type="module" src="/entry.js"></script>
            </body>
          </html>
        `,
      );

      const logs: string[] = [];
      const server = http.createServer(async (req, res) => {
        try {
          const urlPath = (req.url || "/").split("?")[0];
          const filePath = urlPath === "/" ? path.join(root, "index.html") : path.join(root, urlPath);
          if (!filePath.startsWith(root)) {
            res.statusCode = 403;
            res.end("forbidden");
            return;
          }
          const data = await fs.readFile(filePath);
          res.setHeader("content-type", contentTypeFor(filePath));
          res.end(data);
        } catch (error) {
          logs.push(`[error] ${req.url}: ${String(error)}`);
          if (logs.length > 200) logs.shift();
          res.statusCode = 404;
          res.end("not found");
        }
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      return {
        serverLogs: () => logs.join("\n"),
        async [Symbol.asyncDispose]() {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    },
    bootTimeoutMs: 30_000,
  });
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
