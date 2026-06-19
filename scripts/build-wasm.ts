import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const upstreamDir = path.join(repoRoot, "typescript-go");
const commandSourceDir = path.join(repoRoot, "go", "tswasm-wasm");
const commandBuildDir = path.join(upstreamDir, "cmd", "tswasm-wasm");
const upstreamLibDir = path.join(upstreamDir, "internal", "bundled", "libs");
const outputDir = path.join(repoRoot, "dist");

prepareCommandPackage();
buildWasm();
copyWasmExecRuntime();

function prepareCommandPackage() {
  rmSync(commandBuildDir, { recursive: true, force: true });
  mkdirSync(path.join(commandBuildDir, "libs"), { recursive: true });
  copyFileSync(
    path.join(commandSourceDir, "main.go"),
    path.join(commandBuildDir, "main.go")
  );

  for (const libFileName of collectReferencedLibFiles("lib.es2024.d.ts")) {
    copyFileSync(
      path.join(upstreamLibDir, libFileName),
      path.join(commandBuildDir, "libs", libFileName)
    );
  }
}

function collectReferencedLibFiles(rootFileName: string) {
  const visited = new Set<string>();
  const visit = (fileName: string) => {
    if (visited.has(fileName)) return;
    const filePath = path.join(upstreamLibDir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Missing upstream lib file: ${fileName}`);
    }
    visited.add(fileName);

    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/<reference\s+lib=["']([^"']+)["']/g)) {
      visit(`lib.${match[1]}.d.ts`);
    }
  };

  visit(rootFileName);

  const files = [...visited].sort();
  const available = new Set(readdirSync(upstreamLibDir));
  for (const decoratorFile of ["lib.decorators.d.ts", "lib.decorators.legacy.d.ts"]) {
    if (available.has(decoratorFile)) {
      files.push(decoratorFile);
    }
  }
  return [...new Set(files)].sort();
}

function buildWasm() {
  mkdirSync(outputDir, { recursive: true });
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w -buildid=",
      "-o",
      path.join(outputDir, "tswasm.wasm"),
      "./cmd/tswasm-wasm",
    ],
    {
      cwd: upstreamDir,
      env: {
        ...process.env,
        GOARCH: "wasm",
        GOOS: "js",
      },
      stdio: "inherit",
    }
  );
}

function copyWasmExecRuntime() {
  const goRoot = execFileSync("go", ["env", "GOROOT"], {
    encoding: "utf8",
  }).trim();
  const runtimePath = path.join(outputDir, "wasm_exec.js");
  copyFileSync(path.join(goRoot, "lib", "wasm", "wasm_exec.js"), runtimePath);
  patchRuntimeEntropy(runtimePath);
}

function patchRuntimeEntropy(filePath: string) {
  const original = `\tif (!globalThis.crypto) {
\t\tthrow new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
\t}
`;
  const replacement = `\tif (!globalThis.crypto?.getRandomValues) {
\t\tconst nodeCrypto = globalThis.process?.getBuiltinModule?.("crypto");
\t\tif (nodeCrypto?.webcrypto?.getRandomValues) {
\t\t\tglobalThis.crypto = nodeCrypto.webcrypto;
\t\t} else {
\t\t\tlet seed = 0x12345678;
\t\t\tglobalThis.crypto = {
\t\t\t\tgetRandomValues(target) {
\t\t\t\t\tfor (let i = 0; i < target.length; i++) {
\t\t\t\t\t\tseed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
\t\t\t\t\t\ttarget[i] = seed & 0xff;
\t\t\t\t\t}
\t\t\t\t\treturn target;
\t\t\t\t},
\t\t\t};
\t\t}
\t}
`;

  const runtime = readFileSync(filePath, "utf8");
  if (!runtime.includes(original)) {
    throw new Error("Go wasm_exec.js crypto guard changed; update build script");
  }

  writeFileSync(filePath, runtime.replace(original, replacement));
}
