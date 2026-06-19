#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

interface PackFile {
  path: string;
  size: number;
}

interface PackInfo {
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  files: PackFile[];
  entryCount: number;
}

interface SizeRow {
  label: string;
  raw: number;
  gzip: number;
  brotli: number;
}

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const runtimeAssets = [
  ["API JS", "dist/index.js"],
  ["Types", "dist/index.d.ts"],
  ["Go wasm runtime JS", "dist/wasm_exec.js"],
  ["TypeScript Go wasm", "dist/tswasm.wasm"],
] as const;

const packageInfo = readPackageInfo();
const runtimeRows = runtimeAssets.map(([label, relativePath]) => sizeFile(label, path.join(repoRoot, relativePath)));
const referenceRows = [
  sizeFile("TypeScript JS compiler file", require.resolve("typescript/lib/typescript.js")),
  sizeDirectory("TypeScript JS package", packageDirectory("typescript")),
  sizeFile("ts-morph bundled JS", require.resolve("ts-morph")),
  sizeDirectory("ts-morph package", packageDirectory("ts-morph")),
];

printReport(packageInfo, runtimeRows, referenceRows);

function readPackageInfo(): PackInfo {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const packages = JSON.parse(output) as PackInfo[];
  if (packages.length !== 1) {
    throw new Error(`expected one npm pack result, got ${packages.length}`);
  }

  const pack = packages[0];
  const forbiddenFiles = pack.files.filter((file) => file.path.includes("bench-ts"));
  if (forbiddenFiles.length > 0) {
    throw new Error(`benchmark binaries would be packed: ${forbiddenFiles.map((file) => file.path).join(", ")}`);
  }

  return pack;
}

function sizeFile(label: string, filePath: string): SizeRow {
  if (!existsSync(filePath)) {
    throw new Error(`missing ${filePath}; run pnpm run build first`);
  }
  const bytes = readFileSync(filePath);
  return {
    label,
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }).byteLength,
  };
}

function sizeDirectory(label: string, directoryPath: string): SizeRow {
  return {
    label,
    raw: directorySize(realpathSync(directoryPath)),
    gzip: 0,
    brotli: 0,
  };
}

function packageDirectory(packageName: string): string {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function directorySize(directoryPath: string): number {
  let total = 0;
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(entryPath);
    } else if (entry.isFile()) {
      total += statSync(entryPath).size;
    }
  }
  return total;
}

function printReport(pack: PackInfo, runtimeRows: SizeRow[], referenceRows: SizeRow[]) {
  const runtimeTotal = totalRow("Runtime payload total", runtimeRows);

  console.log("# tswasm size report");
  console.log("");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log("");
  console.log("## Packed package");
  console.log("");
  console.log("| Package | packed tarball | unpacked install | files |");
  console.log("|---|---:|---:|---:|");
  console.log(`| ${pack.name}@${pack.version} | ${formatBytes(pack.size)} | ${formatBytes(pack.unpackedSize)} | ${pack.entryCount} |`);
  console.log("");
  console.log("## Runtime assets");
  console.log("");
  console.log("| Asset | raw | gzip | brotli |");
  console.log("|---|---:|---:|---:|");
  for (const row of [...runtimeRows, runtimeTotal]) {
    console.log(`| ${row.label} | ${formatBytes(row.raw)} | ${formatBytes(row.gzip)} | ${formatBytes(row.brotli)} |`);
  }
  console.log("");
  console.log("## Local JS compiler references");
  console.log("");
  console.log("| Reference | raw/install | gzip | brotli |");
  console.log("|---|---:|---:|---:|");
  for (const row of referenceRows) {
    console.log(`| ${row.label} | ${formatBytes(row.raw)} | ${formatOptionalBytes(row.gzip)} | ${formatOptionalBytes(row.brotli)} |`);
  }
}

function totalRow(label: string, rows: SizeRow[]): SizeRow {
  return {
    label,
    raw: rows.reduce((total, row) => total + row.raw, 0),
    gzip: rows.reduce((total, row) => total + row.gzip, 0),
    brotli: rows.reduce((total, row) => total + row.brotli, 0),
  };
}

function formatOptionalBytes(value: number) {
  if (value === 0) {
    return "-";
  }
  return formatBytes(value);
}

function formatBytes(bytes: number) {
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= mib) {
    return `${(bytes / mib).toFixed(2)} MiB`;
  }
  if (bytes >= kib) {
    return `${(bytes / kib).toFixed(2)} KiB`;
  }
  return `${bytes} B`;
}
