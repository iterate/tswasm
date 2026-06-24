// @ts-ignore Generated into dist by scripts/build-wasm.ts.
import "./wasm_exec.js";

export interface CompileRequest {
  code: string;
  fileName?: string;
}

export type SourceFileMap = Record<string, string>;

export interface CompileProjectRequest {
  files: SourceFileMap;
  /** Virtual path to a config file inside files, for example "tsconfig.lib.json". */
  tsconfig?: string;
  /** Virtual current directory for resolving relative project paths. */
  cwd?: string;
}

export interface CompileResult {
  js: string;
  outputs: Record<string, string>;
  diagnostics: Diagnostic[];
  success: boolean;
  compiler: CompilerInfo;
}

export interface Diagnostic {
  message: string;
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
  fileName?: string;
  line?: number;
  column?: number;
}

export interface CompilerInfo {
  name: string;
  runtime: string;
  mode: string;
  lib: string;
}

export interface Compiler {
  compile(code: string): CompileResult;
  compile(request: CompileRequest): CompileResult;
  compile(request: CompileProjectRequest): CompileResult;
}

export interface CreateCompilerOptions {
  wasm?: WebAssembly.Module | URL | string;
}

export const compilerInfo: CompilerInfo = {
  name: "typescript-go (tsgo)",
  runtime: "Go wasm",
  mode: "in-memory virtual TypeScript project",
  lib: "bundled TypeScript lib.es2024.d.ts",
};

type NativeCompile = (requestJson: string) => string;

interface NativeCompileResult {
  js: string;
  outputs: Record<string, string>;
  diagnostics: Diagnostic[];
  success: boolean;
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface GoConstructor {
  new (): GoRuntime;
}

declare global {
  var Go: GoConstructor | undefined;
  var __tswasmCompile: NativeCompile | undefined;
}

export async function createCompiler(
  options: CreateCompilerOptions = {}
): Promise<Compiler> {
  const wasm = options.wasm || defaultWasmUrl();
  const nativeCompile = await createNativeCompile(wasm);

  return {
    compile(input: string | CompileRequest | CompileProjectRequest) {
      const request = normalizeCompileInput(input);
      const nativeResult = JSON.parse(
        nativeCompile(JSON.stringify(request))
      ) as NativeCompileResult;
      return {
        ...nativeResult,
        compiler: compilerInfo,
      };
    },
  };
}

function normalizeCompileInput(
  input: string | CompileRequest | CompileProjectRequest
) {
  if (typeof input === "string") {
    return { code: input };
  }

  if (typeof (input as CompileRequest).code === "string") {
    return input;
  }

  return input;
}

function defaultWasmUrl(): URL {
  // Keep module-url syntax out of this module so Metro-style classic script
  // bundles can parse the package when callers provide options.wasm.
  const stack = new Error().stack || "";
  const urlMatch = stack.match(/(?:file|https?):\/\/[^\s)]+\/index\.js(?::\d+:\d+)?/u);
  if (urlMatch) {
    return new URL("./tswasm.wasm", urlMatch[0].replace(/:\d+:\d+$/u, ""));
  }

  const pathMatch = stack.match(/(?:\/|[A-Za-z]:\\)[^\s)]+[/\\]index\.js(?::\d+:\d+)?/u);
  const nodeUrl = nodeBuiltin("url") as Pick<typeof import("node:url"), "pathToFileURL"> | undefined;
  if (pathMatch && nodeUrl?.pathToFileURL) {
    return new URL("./tswasm.wasm", nodeUrl.pathToFileURL(pathMatch[0].replace(/:\d+:\d+$/u, "")));
  }

  const nodeProcess = globalThis.process as NodeJS.Process | undefined;
  const nodeFs = nodeBuiltin("fs") as Pick<typeof import("node:fs"), "existsSync"> | undefined;
  const nodePath = nodeBuiltin("path") as Pick<typeof import("node:path"), "join"> | undefined;
  if (nodeProcess?.cwd && nodeUrl?.pathToFileURL && nodeFs?.existsSync && nodePath?.join) {
    const repoLocalWasm = nodePath.join(nodeProcess.cwd(), "dist", "tswasm.wasm");
    if (nodeFs.existsSync(repoLocalWasm)) {
      return nodeUrl.pathToFileURL(repoLocalWasm);
    }
  }

  const location = globalThis.location;
  if (location?.href) {
    return new URL("./tswasm.wasm", location.href);
  }

  throw new Error("createCompiler requires options.wasm when tswasm.wasm cannot be resolved automatically");
}

async function createNativeCompile(
  wasmInput: WebAssembly.Module | URL | string
): Promise<NativeCompile> {
  if (!globalThis.Go) {
    throw new Error("Go wasm runtime did not initialize");
  }

  const go = new globalThis.Go();
  const instance = await instantiateWasm(wasmInput, go.importObject);
  void go.run(instance).catch((error) => {
    console.error("tswasm runtime exited", error);
  });

  return waitForNativeCompileRegistration();
}

async function waitForNativeCompileRegistration(): Promise<NativeCompile> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const compile = globalThis.__tswasmCompile;
    if (compile) {
      return compile;
    }
    await Promise.resolve();
  }

  throw new Error("tswasm compiler did not register __tswasmCompile");
}

async function instantiateWasm(
  wasmInput: WebAssembly.Module | URL | string,
  imports: WebAssembly.Imports
): Promise<WebAssembly.Instance> {
  if (wasmInput instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(wasmInput, imports);
  }

  const wasmBytes = await readWasmBytes(wasmInput);
  const instantiated = await WebAssembly.instantiate(wasmBytes, imports);
  return instantiated.instance;
}

async function readWasmBytes(input: URL | string): Promise<ArrayBuffer> {
  const url = resolveWasmUrl(input);
  if (url.protocol === "file:") {
    const { readFile } = await importNodeFsPromises();
    const bytes = await readFile(url);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to load tswasm wasm: ${response.status}`);
  }
  return response.arrayBuffer();
}

function resolveWasmUrl(input: URL | string): URL {
  if (input instanceof URL) {
    return input;
  }

  try {
    return new URL(input);
  } catch {
    return new URL(input, defaultWasmUrl());
  }
}

async function importNodeFsPromises(): Promise<typeof import("node:fs/promises")> {
  const fs = nodeBuiltin("fs") as typeof import("node:fs") | undefined;
  if (!fs?.promises?.readFile) {
    throw new Error("file: wasm URLs require Node.js process.getBuiltinModule('fs')");
  }
  return fs.promises;
}

function nodeBuiltin(name: string): unknown {
  const nodeProcess = globalThis.process as
    | (NodeJS.Process & {
        getBuiltinModule?: (name: string) => unknown;
      })
    | undefined;
  return nodeProcess?.getBuiltinModule?.(name);
}
