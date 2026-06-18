/**
 * agent-profiler CLI
 *
 * Commands:
 *   start   – start server as a background daemon
 *   stop    – stop the background daemon
 *   status  – show running/stopped + healthz
 *   logs    – print (and optionally tail) the daemon log
 *   open    – open the web UI in the default browser
 *
 * State dir: ~/.agent-profiler/
 *   agent-profiler.pid  – daemon PID
 *   agent-profiler.log  – server stdout + stderr
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Paths ─────────────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".agent-profiler");
const PID_FILE = join(STATE_DIR, "agent-profiler.pid");
const LOG_FILE = join(STATE_DIR, "agent-profiler.log");

// The server entrypoint lives next to this file in the published package.
// In the monorepo (bun dev / bun build --compile), resolve relative to here.
const SERVER_ENTRY = join(import.meta.dir, "../../server/src/index.ts");
// Compiled server bundle shipped inside this package (built by `bun build`).
const SERVER_BUNDLE = join(import.meta.dir, "../server/index.js");
// The SPA assets shipped alongside the server bundle.
const WEB_DIST = join(import.meta.dir, "../web");

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

// ── PID helpers ───────────────────────────────────────────────────────────────

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(pid: number): void {
  ensureStateDir();
  writeFileSync(PID_FILE, String(pid), "utf8");
}

function clearPid(): void {
  if (existsSync(PID_FILE)) {
    import("fs").then(({ unlinkSync }) => unlinkSync(PID_FILE));
  }
}

// ── Health check ──────────────────────────────────────────────────────────────

const port = Number(process.env.AGENT_PROFILER_PORT ?? 7070);

async function checkHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean; version?: string };
      return { ok: true, detail: `v${body.version ?? "?"}` };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStart(): Promise<void> {
  const existing = readPid();
  if (existing !== null && isRunning(existing)) {
    console.log(`agent-profiler is already running (PID ${existing}) on http://localhost:${port}`);
    return;
  }

  ensureStateDir();

  // Resolve the server to run: prefer bundled JS, fall back to TS source (monorepo dev).
  let argv: string[];
  let extraEnv: Record<string, string> = {};
  if (existsSync(SERVER_BUNDLE)) {
    argv = [process.execPath, "run", SERVER_BUNDLE];
    extraEnv = { AGENT_PROFILER_WEB_DIST: WEB_DIST };
  } else if (existsSync(SERVER_ENTRY)) {
    argv = [process.execPath, "run", SERVER_ENTRY]; // monorepo dev path
  } else {
    console.error("Cannot find server bundle or source. Re-install agent-profiler.");
    process.exit(1);
  }

  const logFd = openSync(LOG_FILE, "a");
  const child = Bun.spawn(argv, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...extraEnv },
  });

  writePid(child.pid);
  // Unref so the CLI process can exit without waiting for the child
  child.unref();

  // Wait briefly then confirm it's up
  await new Promise((r) => setTimeout(r, 1000));
  const health = await checkHealth();
  if (health.ok) {
    console.log(`agent-profiler started (PID ${child.pid}) — http://localhost:${port}`);
    console.log(`  log: ${LOG_FILE}`);
  } else {
    console.log(`agent-profiler started (PID ${child.pid}) — waiting for server (${health.detail})`);
    console.log(`  log: ${LOG_FILE}`);
  }
}

async function cmdStop(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log("agent-profiler is not running (no PID file).");
    return;
  }
  if (!isRunning(pid)) {
    console.log(`agent-profiler is not running (stale PID ${pid}).`);
    clearPid();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    // Wait up to 3s for clean exit
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!isRunning(pid)) break;
    }
    if (isRunning(pid)) {
      process.kill(pid, "SIGKILL");
    }
    clearPid();
    console.log(`agent-profiler stopped (PID ${pid}).`);
  } catch (e: unknown) {
    console.error("Failed to stop:", e);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  const pid = readPid();
  const alive = pid !== null && isRunning(pid);

  if (!alive) {
    if (pid !== null) clearPid();
    // Maybe started outside of this CLI — check healthz anyway
    const health = await checkHealth();
    if (health.ok) {
      console.log(`running  (external process) — http://localhost:${port}  ${health.detail}`);
    } else {
      console.log(`stopped`);
    }
    return;
  }

  const health = await checkHealth();
  const healthStr = health.ok ? `healthy  ${health.detail}` : `unreachable (${health.detail})`;
  console.log(`running  PID ${pid}  http://localhost:${port}  ${healthStr}`);
  console.log(`  log: ${LOG_FILE}`);
}

async function cmdLogs(follow: boolean): Promise<void> {
  if (!existsSync(LOG_FILE)) {
    console.log(`No log file yet. Run 'agent-profiler start' first.`);
    console.log(`Expected: ${LOG_FILE}`);
    return;
  }
  if (follow) {
    // Stream the file; basic tail -f equivalent
    const proc = Bun.spawn(["tail", "-f", LOG_FILE], { stdio: ["ignore", "inherit", "inherit"] });
    await proc.exited;
  } else {
    const content = readFileSync(LOG_FILE, "utf8");
    // Print last 100 lines by default
    const lines = content.split("\n");
    console.log(lines.slice(-100).join("\n"));
  }
}

async function cmdOpen(): Promise<void> {
  const url = `http://localhost:${port}`;
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "start" :
    "xdg-open";
  Bun.spawn([opener, url], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`Opening ${url}`);
}

// ── Help ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
agent-profiler — local-first AI agent observability

Usage:
  agent-profiler <command> [options]

Commands:
  start          Start the server as a background daemon
  stop           Stop the background daemon
  status         Show whether the server is running
  logs [-f]      Print server logs (-f to follow/tail)
  open           Open the web UI in your browser

Environment:
  AGENT_PROFILER_PORT     Server port (default: 7070)
  AGENT_PROFILER_DB_PATH  SQLite database path (default: ~/.agent-profiler/agent-profiler.sqlite)

Examples:
  agent-profiler start
  agent-profiler status
  agent-profiler logs -f
  agent-profiler stop
`.trim());
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case "start":
    await cmdStart();
    break;
  case "stop":
    await cmdStop();
    break;
  case "status":
    await cmdStatus();
    break;
  case "logs":
    await cmdLogs(rest.includes("-f") || rest.includes("--follow"));
    break;
  case "open":
    await cmdOpen();
    break;
  case undefined:
  case "--help":
  case "-h":
  case "help":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
