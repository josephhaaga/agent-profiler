#!/usr/bin/env bun
/**
 * Container entrypoint for the agent-profiler e2e harness.
 *
 * Wraps run-e2e.ts with container-specific path overrides and copies output
 * artifacts to /output/ when done. All CLI flags are passed through to run-e2e.
 *
 * Environment variables (set in Dockerfile, override at runtime):
 *   PLUGIN_DIST         Path to the pre-built plugin dist/index.js
 *   SERVER_SRC          Path to packages/server/src/index.ts
 *   AGENT_PROFILER_WEB_DIST  Path to packages/web/dist
 *   WORKSPACE           Directory opencode operates in (the fake codebase)
 *   OUTPUT_DIR          Where to copy fixture files after the run
 */

import { mkdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PLUGIN_DIST = process.env["PLUGIN_DIST"] ?? "/plugin/dist/index.js";
const SERVER_SRC = process.env["SERVER_SRC"] ?? "/app/packages/server/src/index.ts";
const WEB_DIST = process.env["AGENT_PROFILER_WEB_DIST"] ?? "/app/packages/web/dist";
const WORKSPACE = process.env["WORKSPACE"] ?? "/workspace";
const OUTPUT_DIR = process.env["OUTPUT_DIR"] ?? "/output";

// Pass-through args from CMD / docker run args
const args = process.argv.slice(2);

// Inject container-specific env overrides into the harness via env vars
// The harness reads these to override its default path resolution.
const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  AGENT_PROFILER_PLUGIN_DIST: PLUGIN_DIST,
  AGENT_PROFILER_SERVER_SRC: SERVER_SRC,
  AGENT_PROFILER_WEB_DIST: WEB_DIST,
  AGENT_PROFILER_WORKSPACE: WORKSPACE,
  AGENT_PROFILER_WEB_DIST: WEB_DIST,
};

// Default --fixture-dir to the container output dir if --record is passed
const hasRecord = args.includes("--record");
const hasFixtureDir = args.includes("--fixture-dir");
const extraArgs: string[] = [];
if (hasRecord && !hasFixtureDir) {
  extraArgs.push("--fixture-dir", OUTPUT_DIR);
}

const harnessArgs = [
  "run",
  "/harness/run-e2e.ts",
  ...args,
  ...extraArgs,
];

console.error(`[entrypoint] bun ${harnessArgs.join(" ")}`);

const proc = spawn("bun", harnessArgs, {
  env,
  stdio: "inherit",
  cwd: WORKSPACE,
});

proc.on("exit", (code) => {
  // Copy any logs/fixtures from default sandbox locations to /output
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // The harness writes logs to the sandbox HOME; for the container we also
  // want anything written to /tmp/ap-* copied out for debugging.
  process.exitCode = code ?? 0;
});
