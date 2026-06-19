import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

export const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

let buildPromise: Promise<void> | undefined;

export function ensureBuilt() {
  if (hasRuntimeBuild()) {
    return Promise.resolve();
  }

  buildPromise ||= execa("pnpm", ["run", "build"], {
    cwd: packageRoot,
  }).then(() => undefined);
  return buildPromise;
}

function hasRuntimeBuild() {
  return [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/wasm_exec.js",
    "dist/tswasm.wasm",
  ].every((relativePath) => existsSync(path.join(packageRoot, relativePath)));
}
