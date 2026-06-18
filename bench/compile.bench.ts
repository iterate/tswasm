#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Project } from "ts-morph";
import { Bench } from "tinybench";
import ts from "typescript";

import { createCompiler, type Compiler, type CompileResult } from "../dist/index.js";

interface SourceCase {
  name: string;
  fileName: string;
  code: string;
}

interface BenchOptions {
  filter: string;
  json: string;
  quick: boolean;
  skipNative: boolean;
  time: number;
  warmupTime: number;
  iterations: number;
  warmupIterations: number;
  fixedSamples: number;
}

interface BenchRow {
  group: string;
  name: string;
  samples: number;
  meanMs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  hz: number;
  rme: number | null;
  method: "tinybench" | "fixed-samples";
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const typescriptGoRoot = path.join(repoRoot, "typescript-go");
const tsgoBinary = path.join(repoRoot, "dist", "bench-tsgo");
const temporaryDirectories: string[] = [];

process.once("exit", cleanupTemporaryDirectories);

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.ESNext,
  strict: true,
  skipLibCheck: true,
  sourceMap: false,
  declaration: false,
};

const sourceCases: SourceCase[] = [
  {
    name: "simple snippet",
    fileName: "simple.ts",
    code: `
async function value(input: Iterable<number>): Promise<number[]> {
  const doubled = Array.from(input, item => item * 2).toSorted((a, b) => a - b);
  const values = new Map<number, Promise<number>>();
  values.set(doubled.length, Promise.resolve(doubled.at(-1) || 0));
  return Promise.all(values.values());
}
`,
  },
  {
    name: "type-heavy snippet",
    fileName: "type-heavy.ts",
    code: `
type JsonPrimitive = string | number | boolean | null;

type Jsonify<T> = T extends JsonPrimitive
  ? T
  : T extends Date
    ? string
    : T extends Array<infer Item>
      ? Jsonify<Item>[]
      : T extends object
        ? { [K in keyof T]: Jsonify<T[K]> }
        : never;

type EventMap = {
  click: { x: number; y: number; meta: { createdAt: Date; tags: string[] } };
  keydown: { key: string; code: string; repeat: boolean };
  resize: { width: number; height: number };
};

type ListenerMap<T extends object> = {
  [K in keyof T as \`on\${Capitalize<string & K>}\`]: (event: T[K]) => Jsonify<T[K]>;
};

declare function createEmitter<T extends object>(): {
  listeners: ListenerMap<T>;
  on<K extends keyof T>(event: K, handler: (data: T[K]) => Jsonify<T[K]>): void;
  emit<K extends keyof T>(event: K, data: T[K]): Jsonify<T[K]>;
};

const emitter = createEmitter<EventMap>();
emitter.on("click", event => ({
  x: event.x,
  y: event.y,
  meta: {
    createdAt: event.meta.createdAt.toISOString(),
    tags: event.meta.tags,
  },
}));
const key = emitter.emit("keydown", { key: "Enter", code: "Enter", repeat: false });
const listeners: ListenerMap<EventMap> = emitter.listeners;
listeners.onResize({ width: 800, height: 600 });
key.code.toLowerCase();
`,
  },
];

const options = readOptions();

if (!existsSync(path.join(repoRoot, "dist", "index.js"))) {
  throw new Error("dist/index.js is missing. Run `pnpm run build` before benchmarking.");
}

if (!options.skipNative) {
  buildTsgoBinary();
}

const warmCompiler = await createCompiler();
const rows: BenchRow[] = [];

for (const source of sourceCases) {
  if (!matchesFilter(source.name, options.filter)) {
    continue;
  }

  validateSourceCase(source, warmCompiler);
  rows.push(...await runTinybenchRows(source, warmCompiler));

  if (matchesFilter("tswasm cold createCompiler+compile", options.filter)) {
    rows.push(await runFixedSampleRow(
      source,
      "tswasm cold createCompiler+compile",
      async () => {
        const compiler = await createCompiler();
        assertTswasmResult(compiler.compile({ code: source.code, fileName: source.fileName }));
      },
    ));
  }

  if (!options.skipNative && matchesFilter("tsgo native CLI (process+files)", options.filter)) {
    rows.push(await runFixedSampleRow(
      source,
      "tsgo native CLI (process+files)",
      createTsgoCliRunner(source),
    ));
  }
}

printSummary(rows);

if (options.json) {
  writeJsonOutput(rows, options.json);
}

function readOptions(): BenchOptions {
  const { values } = parseArgs({
    options: {
      filter: { type: "string", default: "" },
      json: { type: "string", default: "" },
      quick: { type: "boolean", default: false },
      "skip-native": { type: "boolean", default: false },
      time: { type: "string", default: "" },
      "fixed-samples": { type: "string", default: "" },
    },
  });

  const quick = values.quick;
  const time = values.time ? Number(values.time) : quick ? 120 : 500;
  const fixedSamples = values["fixed-samples"]
    ? Number(values["fixed-samples"])
    : quick
      ? 2
      : 5;

  return {
    filter: values.filter,
    json: values.json,
    quick,
    skipNative: values["skip-native"],
    time,
    warmupTime: quick ? 50 : 150,
    iterations: quick ? 3 : 10,
    warmupIterations: quick ? 1 : 3,
    fixedSamples,
  };
}

function buildTsgoBinary() {
  mkdirSync(path.dirname(tsgoBinary), { recursive: true });
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags=-s -w -buildid=",
      "-o",
      tsgoBinary,
      "./cmd/tsgo",
    ],
    {
      cwd: typescriptGoRoot,
      stdio: "pipe",
    },
  );
}

function validateSourceCase(source: SourceCase, compiler: Compiler) {
  assertTswasmResult(compiler.compile({ code: source.code, fileName: source.fileName }));
  compileWithTypeScriptProgram(source);
  compileWithTranspileModule(source);
  compileWithTsMorph(source);
  if (!options.skipNative) {
    createTsgoCliRunner(source)();
  }
}

async function runTinybenchRows(source: SourceCase, compiler: Compiler): Promise<BenchRow[]> {
  const bench = new Bench({
    name: source.name,
    time: options.time,
    warmupTime: options.warmupTime,
    iterations: options.iterations,
    warmupIterations: options.warmupIterations,
    retainSamples: true,
    throws: true,
  });

  const tasks = [
    {
      name: "tswasm warm compile",
      run: () => {
        assertTswasmResult(compiler.compile({ code: source.code, fileName: source.fileName }));
      },
    },
    {
      name: "TypeScript JS full program (in-memory)",
      run: () => {
        compileWithTypeScriptProgram(source);
      },
    },
    {
      name: "TypeScript JS transpileModule (emit only)",
      run: () => {
        compileWithTranspileModule(source);
      },
    },
    {
      name: "ts-morph full program (in-memory)",
      run: () => {
        compileWithTsMorph(source);
      },
    },
  ];

  for (const task of tasks) {
    if (matchesFilter(task.name, options.filter)) {
      bench.add(task.name, task.run, { async: false });
    }
  }

  if (bench.tasks.length === 0) {
    return [];
  }

  await bench.run();
  return bench.tasks.map((task): BenchRow => {
    const result = task.result;
    if (result.state !== "completed") {
      throw new Error(`Benchmark task did not complete: ${task.name}`);
    }
    return {
      group: source.name,
      name: task.name,
      samples: result.latency.samplesCount,
      meanMs: result.latency.mean,
      medianMs: result.latency.p50,
      minMs: result.latency.min,
      maxMs: result.latency.max,
      hz: result.throughput.mean,
      rme: result.latency.rme,
      method: "tinybench",
    };
  });
}

async function runFixedSampleRow(
  source: SourceCase,
  name: string,
  run: () => void | Promise<void>,
): Promise<BenchRow> {
  const samples: number[] = [];
  for (let i = 0; i < options.fixedSamples; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }

  return {
    group: source.name,
    name,
    ...summarize(samples),
    rme: null,
    method: "fixed-samples",
  };
}

function compileWithTypeScriptProgram(source: SourceCase) {
  const fileName = `/${source.fileName}`;
  const output = new Map<string, string>();
  const host = ts.createCompilerHost(compilerOptions);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (requestedFileName) => {
    if (requestedFileName === fileName) return true;
    return originalFileExists(requestedFileName);
  };
  host.readFile = (requestedFileName) => {
    if (requestedFileName === fileName) return source.code;
    return originalReadFile(requestedFileName);
  };
  host.getSourceFile = (requestedFileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (requestedFileName === fileName) {
      return ts.createSourceFile(requestedFileName, source.code, languageVersion, true);
    }
    return originalGetSourceFile(
      requestedFileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    );
  };
  host.writeFile = (fileName, text) => {
    output.set(fileName, text);
  };

  const program = ts.createProgram([fileName], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const emit = program.emit();
  const allDiagnostics = diagnostics.concat(emit.diagnostics);
  assertNoTypeScriptErrors("TypeScript JS full program", allDiagnostics);
  if (output.size === 0) {
    throw new Error("TypeScript JS full program did not emit output");
  }
}

function compileWithTranspileModule(source: SourceCase) {
  const result = ts.transpileModule(source.code, {
    fileName: source.fileName,
    compilerOptions,
    reportDiagnostics: true,
  });
  assertNoTypeScriptErrors("TypeScript JS transpileModule", result.diagnostics || []);
  if (!result.outputText) {
    throw new Error("TypeScript JS transpileModule did not emit output");
  }
}

function compileWithTsMorph(source: SourceCase) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions,
  });
  project.createSourceFile(`/${source.fileName}`, source.code);
  const diagnostics = project.getPreEmitDiagnostics();
  if (diagnostics.length > 0) {
    throw new Error(`ts-morph diagnostics:\n${project.formatDiagnosticsWithColorAndContext(diagnostics)}`);
  }
  const emit = project.emitToMemory();
  if (emit.getFiles().length === 0) {
    throw new Error("ts-morph did not emit output");
  }
}

function createTsgoCliRunner(source: SourceCase): () => void {
  const directory = mkdtempSync(path.join(os.tmpdir(), `tswasm-${slug(source.name)}-`));
  temporaryDirectories.push(directory);
  const inputPath = path.join(directory, source.fileName);
  const configPath = path.join(directory, "tsconfig.json");
  const outDir = path.join(directory, "out");

  writeFileSync(inputPath, source.code);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          module: "ESNext",
          strict: true,
          skipLibCheck: true,
          sourceMap: false,
          declaration: false,
          outDir: "out",
        },
        files: [source.fileName],
      },
      null,
      2,
    )}\n`,
  );

  return () => {
    rmSync(outDir, { recursive: true, force: true });
    execFileSync(tsgoBinary, ["--project", configPath, "--pretty", "false"], {
      cwd: directory,
      stdio: "pipe",
    });
  };
}

function assertTswasmResult(result: CompileResult) {
  if (!result.success) {
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    throw new Error(`tswasm diagnostics:\n${messages}`);
  }
  if (!result.js) {
    throw new Error("tswasm did not emit output");
  }
}

function assertNoTypeScriptErrors(label: string, diagnostics: ts.Diagnostic[]) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) {
    return;
  }

  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
  };
  throw new Error(`${label} diagnostics:\n${ts.formatDiagnosticsWithColorAndContext(errors, host)}`);
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, sample) => total + sample, 0);
  const meanMs = sum / sorted.length;
  const medianMs = percentile(sorted, 0.5);
  return {
    samples: sorted.length,
    meanMs,
    medianMs,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    hz: 1000 / meanMs,
  };
}

function percentile(sorted: number[], p: number) {
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function printSummary(allRows: BenchRow[]) {
  const env = environmentSummary();
  console.log("# tswasm compile benchmarks");
  console.log("");
  console.log(`Date: ${env.date}`);
  console.log(`Runtime: ${env.runtime}`);
  console.log(`CPU: ${env.cpu}`);
  console.log(`TypeScript JS: ${env.typescript}`);
  console.log(`ts-morph: ${env.tsMorph}`);
  console.log(`tsgo native: ${options.skipNative ? "skipped" : env.tsgo}`);
  console.log("");
  console.log("Lower latency is better. Tinybench rows use a time-driven loop; startup-heavy rows use fixed samples.");
  console.log("");

  for (const source of sourceCases) {
    const rows = allRows.filter((row) => row.group === source.name);
    if (rows.length === 0) {
      continue;
    }
    console.log(`## ${source.name}`);
    console.log("");
    console.log(markdownTable(rows));
    console.log("");
  }
}

function markdownTable(rows: BenchRow[]) {
  const fastest = Math.min(...rows.map((row) => row.meanMs));
  const lines = [
    "| Benchmark | mean ms | median ms | samples | vs fastest | notes |",
    "|---|---:|---:|---:|---:|---|",
  ];

  for (const row of [...rows].sort((a, b) => a.meanMs - b.meanMs)) {
    const ratio = row.meanMs / fastest;
    const vs = ratio < 1.005 ? "fastest" : `${ratio.toFixed(2)}x slower`;
    const notes = row.method === "fixed-samples"
      ? "fixed samples"
      : row.rme === null
        ? ""
        : `rme ${row.rme.toFixed(2)}%`;
    lines.push(
      `| ${row.name} | ${formatNumber(row.meanMs)} | ${formatNumber(row.medianMs)} | ${row.samples} | ${vs} | ${notes} |`,
    );
  }

  return lines.join("\n");
}

function writeJsonOutput(allRows: BenchRow[], filePath: string) {
  const resolvedPath = path.resolve(repoRoot, filePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(
    resolvedPath,
    `${JSON.stringify(
      {
        environment: environmentSummary(),
        options,
        rows: allRows,
      },
      null,
      2,
    )}\n`,
  );
}

function environmentSummary() {
  return {
    date: new Date().toISOString(),
    runtime: `${process.release.name} ${process.version} ${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model || "unknown",
    typescript: ts.version,
    tsMorph: readPackageVersion("ts-morph"),
    tsgo: options.skipNative ? "" : readTsgoVersion(),
  };
}

function readPackageVersion(packageName: string) {
  const packageJsonPath = path.join(repoRoot, "node_modules", packageName, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
  return packageJson.version;
}

function readTsgoVersion() {
  const output = execFileSync(tsgoBinary, ["--version"], { encoding: "utf8" }).trim();
  return output;
}

function matchesFilter(value: string, filter: string) {
  if (!filter) return true;
  return value.toLowerCase().includes(filter.toLowerCase());
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function formatNumber(value: number) {
  if (value >= 100) return value.toFixed(1);
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

function cleanupTemporaryDirectories() {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
}
