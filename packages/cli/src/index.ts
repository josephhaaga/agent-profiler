/**
 * agent-profiler CLI — Node-compatible (no Bun APIs)
 *
 * Spawns the bundled server binary (bun build --compile output).
 * Works with plain `npx` — Node is the only runtime requirement for the CLI itself.
 *
 * State dir: ~/.agent-profiler/
 *   agent-profiler.pid  – daemon PID
 *   agent-profiler.log  – server stdout + stderr
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Paths ─────────────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".agent-profiler");
const PID_FILE  = join(STATE_DIR, "agent-profiler.pid");
const LOG_FILE  = join(STATE_DIR, "agent-profiler.log");

// Compiled server binary shipped inside this package.
// bun build --compile produces a platform-native executable — no Bun needed at runtime.
const SERVER_BIN = join(__dirname, "server-bin");

// ── PID helpers ───────────────────────────────────────────────────────────────

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writePid(pid: number): void {
  ensureStateDir();
  writeFileSync(PID_FILE, String(pid), "utf8");
}

function clearPid(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

// ── Health check ──────────────────────────────────────────────────────────────

const port = Number(process.env.AGENT_PROFILER_PORT ?? 7070);

async function checkHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`http://localhost:${port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const body = (await res.json()) as { ok: boolean; version?: string };
      return { ok: true, detail: `v${body.version ?? "?"}` };
    }
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
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

  if (!existsSync(SERVER_BIN)) {
    console.error(`Server binary not found at ${SERVER_BIN}`);
    console.error(`Try reinstalling: npm install -g @josephhaaga/agent-profiler`);
    process.exit(1);
  }

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(SERVER_BIN, [], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AGENT_PROFILER_WEB_DIST: join(__dirname, "web"),
    },
  });

  child.unref();
  writePid(child.pid!);

  // Wait briefly then confirm it's up
  await new Promise((r) => setTimeout(r, 1500));
  const health = await checkHealth();
  if (health.ok) {
    console.log(`agent-profiler started (PID ${child.pid}) — http://localhost:${port}`);
  } else {
    console.log(`agent-profiler started (PID ${child.pid}) — waiting for server (${health.detail})`);
  }
  console.log(`  log: ${LOG_FILE}`);
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
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isRunning(pid)) break;
  }
  if (isRunning(pid)) process.kill(pid, "SIGKILL");
  clearPid();
  console.log(`agent-profiler stopped (PID ${pid}).`);
}

async function cmdStatus(): Promise<void> {
  const pid = readPid();
  const alive = pid !== null && isRunning(pid);

  if (!alive) {
    if (pid !== null) clearPid();
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

function cmdLogs(follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`No log file yet. Run 'agent-profiler start' first.`);
    return;
  }
  if (follow) {
    const child = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  } else {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n");
    console.log(lines.slice(-100).join("\n"));
  }
}

function cmdOpen(): void {
  const url = `http://localhost:${port}`;
  const opener = process.platform === "darwin" ? "open"
               : process.platform === "win32"  ? "start"
               : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  console.log(`Opening ${url}`);
}

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
`.trim());
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case "start":  await cmdStart(); break;
  case "stop":   await cmdStop();  break;
  case "status": await cmdStatus(); break;
  case "logs":   cmdLogs(rest.includes("-f") || rest.includes("--follow")); break;
  case "open":   cmdOpen(); break;
  case undefined:
  case "--help": case "-h": case "help":
    printHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
