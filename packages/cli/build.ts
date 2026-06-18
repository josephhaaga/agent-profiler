/**
 * Build script for packages/cli
 *
 * Produces dist/:
 *   dist/index.js     — CLI entrypoint (tsc → ESM, Node-compatible, no Bun APIs)
 *   dist/server-bin   — self-contained server binary (bun build --compile)
 *   dist/web/         — SPA assets copied from packages/web/dist/
 *
 * The compiled server binary requires no runtime (not even Bun) on the target machine.
 *
 * Prerequisite: packages/web/dist must exist (run `bun run build` from repo root first).
 */

import { cpSync, mkdirSync, rmSync, existsSync, chmodSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const OUT  = join(import.meta.dir, "dist");

// ── Clean ─────────────────────────────────────────────────────────────────────

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ── 1. Compile CLI with tsc (Node-compatible ESM output) ──────────────────────

console.log("Compiling CLI (tsc)...");
const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.json"], {
  cwd: import.meta.dir,
  stdio: ["ignore", "inherit", "inherit"],
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);
console.log("  → dist/index.js");

// Prepend shebang for direct execution
const cliOut = join(OUT, "index.js");
const existing = await Bun.file(cliOut).text();
await Bun.write(cliOut, `#!/usr/bin/env node\n${existing}`);
chmodSync(cliOut, 0o755);

// ── 2. Compile server to self-contained binary (bun build --compile) ──────────

console.log("Compiling server binary (bun build --compile)...");
const serverBin = join(OUT, "server-bin");
const compile = Bun.spawnSync([
  "bun", "build",
  "--compile",
  "--outfile", serverBin,
  join(ROOT, "packages/server/src/index.ts"),
], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "inherit"],
});
if (compile.exitCode !== 0) process.exit(compile.exitCode ?? 1);
chmodSync(serverBin, 0o755);
console.log("  → dist/server-bin");

// ── 3. Copy SPA assets ────────────────────────────────────────────────────────

const webSrc = join(ROOT, "packages/web/dist");
if (!existsSync(webSrc)) {
  console.error(`packages/web/dist not found — run 'bun run build' from the repo root first.`);
  process.exit(1);
}
console.log("Copying web assets...");
cpSync(webSrc, join(OUT, "web"), { recursive: true });
console.log("  → dist/web/");

console.log("Done.");
