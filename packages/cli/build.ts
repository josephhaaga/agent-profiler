/**
 * Build script for packages/cli
 *
 * Produces dist/:
 *   dist/index.js        — CLI entrypoint (tsc → ESM, Node-compatible)
 *   dist/server/index.js — server bundle (Bun-bundled JS, run via `bun run`)
 *   dist/web/            — SPA assets copied from packages/web/dist/
 *
 * The server bundle is run by `bun run` at daemon start time.
 * Bun must be installed on the user's machine (the CLI checks and errors clearly if not).
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

// ── 1. Compile CLI with tsc (Node-compatible ESM) ─────────────────────────────

console.log("Compiling CLI (tsc)...");
const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.json"], {
  cwd: import.meta.dir,
  stdio: ["ignore", "inherit", "inherit"],
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);

// Prepend shebang for direct execution
const cliOut = join(OUT, "index.js");
const existing = await Bun.file(cliOut).text();
await Bun.write(cliOut, `#!/usr/bin/env node\n${existing}`);
chmodSync(cliOut, 0o755);
console.log("  → dist/index.js");

// ── 2. Bundle server as JS (Bun-bundled, run via `bun run`) ───────────────────

console.log("Bundling server...");
const serverResult = await Bun.build({
  entrypoints: [join(ROOT, "packages/server/src/index.ts")],
  outdir: join(OUT, "server"),
  target: "bun",
  format: "esm",
  minify: false,
});
if (!serverResult.success) {
  for (const msg of serverResult.logs) console.error(msg);
  process.exit(1);
}
console.log("  → dist/server/index.js");

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
