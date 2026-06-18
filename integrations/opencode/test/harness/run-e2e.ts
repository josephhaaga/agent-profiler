#!/usr/bin/env bun
/**
 * Hermetic e2e sandbox launcher for the opencode-agent-profiler plugin.
 *
 * Creates a fully isolated HOME directory, wires up:
 *   - A scripted stub LLM (or real provider / local model)
 *   - A fresh agent-profiler server on an ephemeral port
 *   - A sandbox opencode config that loads the plugin from the local build
 *
 * Usage:
 *   bun run integrations/opencode/test/harness/run-e2e.ts [options] "prompt to run"
 *
 * Options:
 *   --scenario <name>     Stub LLM scenario (default: tool-call-then-text)
 *   --mode stub|real|local  LLM mode (default: stub)
 *   --model <id>          Model id for real/local mode (e.g. anthropic/claude-opus-4-5)
 *   --base-url <url>      Base URL for local mode (e.g. http://localhost:11434/v1)
 *   --record <name>       Copy captured logs to test/fixtures/<name>/ after run
 *   --keep                Keep sandbox dir after run (for debugging)
 *   --fixture-dir <path>  Override fixtures output directory
 *   --timeout <ms>        Max ms to wait for opencode to finish (default: 60000)
 *
 * Env overrides:
 *   ANTHROPIC_API_KEY     Needed for --mode real with anthropic provider
 *   STUB_LLM_PORT         Force a specific port for the stub LLM
 *
 * Output:
 *   Prints a JSON summary to stdout on success.
 *   Exits non-zero on failure.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, mkdtempSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Paths relative to this file
// ---------------------------------------------------------------------------
const HARNESS_DIR = dirname(import.meta.path);
const INTEGRATION_DIR = resolve(HARNESS_DIR, "../..");
const REPO_ROOT = resolve(INTEGRATION_DIR, "../..");
const SERVER_SRC = join(REPO_ROOT, "packages/server/src/index.ts");
const PLUGIN_DIST = join(INTEGRATION_DIR, "dist/index.js");
const FIXTURES_DIR = join(HARNESS_DIR, "../fixtures");
const SCENARIOS_DIR = join(HARNESS_DIR, "scenarios");

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(name);
}
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const mode = (opt("--mode") ?? "stub") as "stub" | "real" | "local";
const scenario = opt("--scenario") ?? "tool-call-then-text";
const recordName = opt("--record");
const keepSandbox = flag("--keep");
const timeoutMs = Number(opt("--timeout") ?? "60000");
const fixtureDir = opt("--fixture-dir") ?? FIXTURES_DIR;
const customModel = opt("--model");
const localBaseUrl = opt("--base-url");

// Last positional arg is the prompt
const prompt = argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--scenario" &&
  argv[argv.indexOf(a) - 1] !== "--mode" && argv[argv.indexOf(a) - 1] !== "--model" &&
  argv[argv.indexOf(a) - 1] !== "--base-url" && argv[argv.indexOf(a) - 1] !== "--record" &&
  argv[argv.indexOf(a) - 1] !== "--fixture-dir" && argv[argv.indexOf(a) - 1] !== "--timeout").at(-1)
  ?? "Say the word PING and nothing else.";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg: string): void {
  console.error(`[run-e2e] ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = srv.port;
    srv.stop(true);
    setTimeout(() => resolve(port), 10);
  });
}

async function waitForHttp(url: string, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* keep waiting */
    }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function spawnProc(cmd: string, args: string[], env: Record<string, string>, label: string): ReturnType<typeof spawn> {
  log(`spawning ${label}: ${cmd} ${args.join(" ")}`);
  const proc = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) log(`[${label}] ${line}`);
    }
  });
  proc.stderr.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) log(`[${label}:err] ${line}`);
    }
  });
  proc.on("error", (e) => log(`[${label}] error: ${e}`));
  return proc;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // 1. Ensure plugin dist is built
  if (!existsSync(PLUGIN_DIST)) {
    log("Plugin dist not found, building...");
    const build = spawn("bun", ["run", "--cwd", INTEGRATION_DIR, "build"], {
      env: process.env,
      stdio: "inherit",
    });
    await new Promise<void>((res, rej) => {
      build.on("exit", (code) => (code === 0 ? res() : rej(new Error(`plugin build failed (exit ${code})`))));
    });
  }

  // 2. Create sandbox HOME
  const sandboxHome = mkdtempSync(join(tmpdir(), "ap-e2e-"));
  log(`sandbox HOME: ${sandboxHome}`);

  const cleanup = () => {
    if (!keepSandbox) {
      try { rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
    } else {
      log(`keeping sandbox: ${sandboxHome}`);
    }
  };

  const procs: ReturnType<typeof spawn>[] = [];
  const killAll = () => {
    for (const p of procs) {
      try { p.kill("SIGTERM"); } catch {}
    }
  };

  process.on("exit", () => { killAll(); cleanup(); });
  process.on("SIGINT", () => process.exit(1));
  process.on("SIGTERM", () => process.exit(1));

  try {
    // 3. Start stub LLM (stub mode only)
    let llmBaseUrl = localBaseUrl ?? "";
    let llmModel = customModel ?? "stub/stub-model";

    if (mode === "stub") {
      const stubPort = Number(process.env["STUB_LLM_PORT"] ?? 0) || await findFreePort();
      log(`starting stub LLM on port ${stubPort}...`);

      // Spawn stub-llm as a subprocess so it has its own event loop
      const stubProc = spawn(
        "bun",
        ["run", join(HARNESS_DIR, "stub-llm.ts"), "--port", String(stubPort), "--scenario", scenario, "--scenario-dir", SCENARIOS_DIR],
        {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      procs.push(stubProc);

      // Wait for stub to print its port line
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("stub LLM did not start in time")), 10_000);
        stubProc.stdout.on("data", (d: Buffer) => {
          const line = d.toString().trim();
          if (line.startsWith("{")) {
            try {
              const info = JSON.parse(line) as { port: number };
              llmBaseUrl = `http://localhost:${info.port}/v1`;
              llmModel = "stub/stub-model";
              log(`stub LLM ready: ${llmBaseUrl}`);
              clearTimeout(t);
              res();
            } catch {}
          }
        });
        stubProc.stderr.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n")) {
            if (line.trim()) log(`[stub-llm:err] ${line}`);
          }
        });
        stubProc.on("exit", (code) => { clearTimeout(t); rej(new Error(`stub LLM exited with ${code}`)); });
      });
    } else if (mode === "local") {
      if (!llmBaseUrl) throw new Error("--base-url required for --mode local");
      if (!customModel) throw new Error("--model required for --mode local");
      llmModel = customModel;
      log(`using local model: ${llmModel} at ${llmBaseUrl}`);
    } else {
      // real mode — use the model as-is; API key must be in env
      if (!customModel) throw new Error("--model required for --mode real");
      llmModel = customModel;
      log(`using real model: ${llmModel}`);
    }

    // 4. Find free port for agent-profiler server
    const serverPort = await findFreePort();
    const dbPath = join(sandboxHome, "agent-profiler.sqlite");
    const hookLogPath = join(sandboxHome, "hooks.ndjson");
    const traceLogPath = join(sandboxHome, "spans.ndjson");

    // 5. Start agent-profiler server
    log(`starting agent-profiler server on port ${serverPort}...`);
    const serverProc = spawnProc(
      "bun",
      ["run", SERVER_SRC],
      {
        AGENT_PROFILER_PORT: String(serverPort),
        AGENT_PROFILER_DB_PATH: dbPath,
        AGENT_PROFILER_WEB_DIST: join(REPO_ROOT, "packages/web/dist"),
      },
      "server",
    );
    procs.push(serverProc);

    await waitForHttp(`http://localhost:${serverPort}/healthz`, 15_000);
    log("agent-profiler server ready");

    // 6. Build sandbox OPENCODE_CONFIG_DIR
    const configDir = join(sandboxHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    // Write the opencode.json
    const pluginEntry = PLUGIN_DIST; // absolute path to local built plugin
    const opencodeConfig: Record<string, unknown> = {
      "$schema": "https://opencode.ai/config.json",
      plugin: [
        [pluginEntry, {
          endpoint: `http://localhost:${serverPort}/v1/traces`,
          hookLog: hookLogPath,
          traceLog: traceLogPath,
        }],
      ],
    };

    // Provider config for stub/local modes
    if (mode === "stub" || mode === "local") {
      opencodeConfig["provider"] = {
        stub: {
          npm: "@ai-sdk/openai-compatible",
          name: "Stub LLM",
          api: llmBaseUrl,
          options: { apiKey: "stub-key" },
          models: {
            "stub-model": {
              id: "stub-model",
              name: "Stub Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
        },
      };
    }

    writeFileSync(join(configDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));
    log(`wrote opencode.json to ${configDir}`);

    // 7. Run opencode headlessly
    log(`running opencode: "${prompt}" with model ${llmModel}`);
    const ocEnv: Record<string, string> = {
      HOME: sandboxHome,
      OPENCODE_CONFIG_DIR: configDir,
      // Silence ambient noise
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    };

    // Pass through real API keys for real mode
    if (mode === "real") {
      for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"]) {
        if (process.env[key]) ocEnv[key] = process.env[key]!;
      }
    }

    const ocArgs = [
      "run",
      "--format", "json",
      "--dangerously-skip-permissions",
      "--model", llmModel,
      prompt,
    ];

    log(`opencode env HOME=${sandboxHome}`);

    const ocOutput: string[] = [];
    const ocStderr: string[] = [];

    const ocProc = spawn("opencode", ocArgs, {
      env: { ...process.env, ...ocEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    ocProc.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      ocOutput.push(s);
      for (const line of s.split("\n")) {
        if (line.trim()) log(`[opencode] ${line}`);
      }
    });
    ocProc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      ocStderr.push(s);
      for (const line of s.split("\n")) {
        if (line.trim()) log(`[opencode:err] ${line}`);
      }
    });

    const ocExitCode = await new Promise<number>((res) => {
      const t = setTimeout(() => {
        log("opencode timed out, killing...");
        ocProc.kill("SIGTERM");
        res(1);
      }, timeoutMs);
      ocProc.on("exit", (code) => {
        clearTimeout(t);
        res(code ?? 0);
      });
    });

    log(`opencode exited with code ${ocExitCode}`);

    // Give server a moment to finish ingesting
    await Bun.sleep(1500);

    // 8. Fetch sessions from server
    let sessions: unknown[] = [];
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/sessions`);
      const data = await res.json() as { sessions?: unknown[] };
      sessions = data.sessions ?? (Array.isArray(data) ? data : []);
    } catch (e) {
      log(`failed to fetch sessions: ${e}`);
    }

    // 9. Fetch full session detail (turns) for each session
    const fullSessions: unknown[] = [];
    for (const sess of sessions as Array<{ id: string }>) {
      try {
        const res = await fetch(`http://localhost:${serverPort}/api/sessions/${sess.id}`);
        fullSessions.push(await res.json());
      } catch {}
    }

    // 10. Save logs
    const expectedSessionsPath = join(sandboxHome, "expected-sessions.json");
    writeFileSync(expectedSessionsPath, JSON.stringify(fullSessions, null, 2));

    const summary = {
      exitCode: ocExitCode,
      sandboxHome,
      sessionCount: sessions.length,
      hookLog: existsSync(hookLogPath) ? hookLogPath : null,
      traceLog: existsSync(traceLogPath) ? traceLogPath : null,
      expectedSessions: expectedSessionsPath,
    };

    // 11. Record fixtures if requested
    if (recordName) {
      const dest = join(fixtureDir, recordName);
      mkdirSync(dest, { recursive: true });

      if (existsSync(hookLogPath)) {
        copyFileSync(hookLogPath, join(dest, "hooks.ndjson"));
        log(`recorded hooks.ndjson → ${dest}`);
      }
      if (existsSync(traceLogPath)) {
        copyFileSync(traceLogPath, join(dest, "spans.ndjson"));
        log(`recorded spans.ndjson → ${dest}`);
      }
      writeFileSync(join(dest, "expected-sessions.json"), JSON.stringify(fullSessions, null, 2));
      log(`recorded expected-sessions.json → ${dest}`);

      // Write metadata
      writeFileSync(join(dest, "meta.json"), JSON.stringify({
        recordedAt: new Date().toISOString(),
        mode,
        scenario: mode === "stub" ? scenario : null,
        model: llmModel,
        prompt,
      }, null, 2));
      log(`fixture recorded: ${dest}`);
    }

    console.log(JSON.stringify(summary, null, 2));

    if (ocExitCode !== 0) {
      process.exitCode = 1;
    }
  } finally {
    killAll();
    // Give procs a moment to die
    await Bun.sleep(300);
    cleanup();
  }
}

main().catch((err) => {
  console.error(`[run-e2e] fatal: ${err}`);
  process.exit(1);
});
