// @ts-ignore Generated into dist by scripts/build-wasm.ts.
import "./wasm_exec.js";

export interface CompileRequest {
  code: string;
  fileName?: string;
}

export interface CompileResult {
  js: string;
  diagnostics: Diagnostic[];
  success: boolean;
  compiler: CompilerInfo;
}

export interface Diagnostic {
  message: string;
  code: number;
  category: "error" | "warning" | "suggestion" | "message";
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
}

export interface CreateCompilerOptions {
  wasm?: WebAssembly.Module | URL | string;
}

export const compilerInfo: CompilerInfo = {
  name: "typescript-go (tsgo)",
  runtime: "Go wasm",
  mode: "single in-memory /input.ts",
  lib: "bundled TypeScript lib.es2024.d.ts",
};

type NativeCompile = (requestJson: string) => string;

interface NativeCompileResult {
  js: string;
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
  const wasm = options.wasm || new URL("./tswasm.wasm", import.meta.url);
  const nativeCompile = await createNativeCompile(wasm);

  return {
    compile(input: string | CompileRequest) {
      const request = typeof input === "string" ? { code: input } : input;
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
  const url = input instanceof URL ? input : new URL(input, import.meta.url);
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
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
