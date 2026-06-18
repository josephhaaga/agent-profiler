/**
 * Build script for packages/cli
 *
 * Produces dist/:
 *   dist/index.js          — CLI entrypoint (bun-bundled, shebang preserved)
 *   dist/server/index.js   — bundled server (all workspace deps inlined)
 *   dist/web/              — copied SPA assets from packages/web/dist/
 *
 * The CLI locates the server bundle and web assets relative to itself at runtime.
 *
 * Prerequisite: run `bun run build` from the monorepo root first so that
 * packages/server/dist and packages/web/dist exist.
 */

import { cpSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const OUT = join(import.meta.dir, "dist");

// ── Clean ─────────────────────────────────────────────────────────────────────

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ── 1. Bundle the server entrypoint (inline all workspace deps) ───────────────

console.log("Bundling server...");
const serverResult = await Bun.build({
  entrypoints: [join(ROOT, "packages/server/src/index.ts")],
  outdir: join(OUT, "server"),
  target: "bun",
  format: "esm",
  // Bun resolves workspace:* deps from node_modules at bundle time
  external: [],
  minify: false,
});

if (!serverResult.success) {
  for (const msg of serverResult.logs) console.error(msg);
  process.exit(1);
}
console.log(`  → dist/server/index.js`);

// ── 2. Copy SPA assets ────────────────────────────────────────────────────────

const webSrc = join(ROOT, "packages/web/dist");
const webDst = join(OUT, "web");

if (!existsSync(webSrc)) {
  console.error(`packages/web/dist not found — run 'bun run build' from the repo root first.`);
  process.exit(1);
}

console.log("Copying web assets...");
cpSync(webSrc, webDst, { recursive: true });
console.log(`  → dist/web/`);

// ── 3. Bundle the CLI entrypoint ──────────────────────────────────────────────

console.log("Bundling CLI...");
const cliResult = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/index.ts")],
  outdir: OUT,
  target: "bun",
  format: "esm",
  external: [],
  minify: false,
});

if (!cliResult.success) {
  for (const msg of cliResult.logs) console.error(msg);
  process.exit(1);
}

// Prepend shebang so the file is directly executable on Unix.
// Bun's `banner` option places text inside the module body, not at byte 0.
const cliOut = join(OUT, "index.js");
const existing = await Bun.file(cliOut).text();
await Bun.write(cliOut, `#!/usr/bin/env bun\n${existing}`);

import { chmodSync } from "fs";
chmodSync(cliOut, 0o755);
console.log(`  → dist/index.js`);

console.log("Done.");
