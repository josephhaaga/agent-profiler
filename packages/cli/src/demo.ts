import { chmodSync, mkdtempSync, rmSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

export interface DemoOptions {
  open: boolean;
}

export interface DemoDependencies {
  bunPath: string;
  serverBundle: string;
  webDist: string;
}

export function parseDemoArgs(args: string[]): DemoOptions {
  let open = true;
  for (const arg of args) {
    if (arg === "--no-open") open = false;
    else throw new Error(`Unknown demo option: ${arg}\nUsage: agent-profiler demo [--no-open]`);
  }
  return { open };
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

const fixtures = [
  {
    info: { id: "ses_demo_ordinary", title: "DEMO — Ordinary session", time: { created: 1_750_000_000_000, updated: 1_750_000_002_000 } },
    messages: [
      { type: "user", id: "msg_demo_ordinary_user", text: "Summarize a synthetic fixture.", time: { created: 1_750_000_000_000 } },
      { type: "assistant", id: "msg_demo_ordinary_answer", model: { id: "demo-model", providerID: "synthetic" },
        time: { created: 1_750_000_001_000, completed: 1_750_000_002_000 },
        tokens: { input: 120, output: 24, reasoning: 0, cache: { read: 16, write: 0 } }, cost: 0.0007,
        finish: "stop", content: [{ type: "text", text: "This is synthetic demo output." }] },
    ],
  },
  {
    info: { id: "ses_demo_tool_error", title: "DEMO — Recorded tool error", time: { created: 1_750_010_000_000, updated: 1_750_010_004_000 } },
    messages: [
      { type: "user", id: "msg_demo_error_user", text: "Write a synthetic fixture file.", time: { created: 1_750_010_000_000 } },
      { type: "assistant", id: "msg_demo_error_answer", model: { id: "demo-model", providerID: "synthetic" },
        time: { created: 1_750_010_001_000, completed: 1_750_010_004_000 },
        tokens: { input: 180, output: 30, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001,
        finish: "stop", content: [
          { type: "text", text: "The demo tool call below has a recorded synthetic error." },
          { type: "tool", id: "tool_demo_failed_write", name: "write_file",
            time: { created: 1_750_010_002_000, ran: 1_750_010_002_000, completed: 1_750_010_003_000 },
            state: { status: "error", input: { path: "demo-only.txt" }, error: { name: "SyntheticToolError", message: "Demo-only simulated failure" } } },
        ] },
    ],
  },
  {
    info: { id: "ses_demo_partial_usage", title: "DEMO — Partial usage coverage", time: { created: 1_750_020_000_000, updated: 1_750_020_002_000 } },
    messages: [
      { type: "user", id: "msg_demo_partial_user", text: "Show missing usage as unknown.", time: { created: 1_750_020_000_000 } },
      { type: "assistant", id: "msg_demo_partial_answer", model: { id: "demo-model", providerID: "synthetic" },
        time: { created: 1_750_020_001_000, completed: 1_750_020_002_000 }, finish: "stop",
        content: [{ type: "text", text: "This fixture intentionally omits token and cost usage." }] },
    ],
  },
];

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const opener = spawn(command, args, { detached: true, stdio: "ignore" });
    opener.on("error", () => {});
    opener.unref();
  } catch {
    // Browser launch is best-effort; the printed URL remains usable.
  }
}

async function seedDemo(url: string): Promise<void> {
  for (const fixture of fixtures) {
    const response = await fetch(`${url}/api/import/opencode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fixture),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Could not seed synthetic demo session (${response.status}): ${detail}`);
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child: ChildProcess, exit: Promise<ChildExit>): Promise<void> {
  try { child.kill("SIGTERM"); } catch { return; }
  const result = await Promise.race([exit, wait(2_000).then(() => undefined)]);
  if (!result) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    await exit;
  }
}

export async function startDemo(options: DemoOptions, dependencies: DemoDependencies): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-profiler-demo-"));
  chmodSync(tempDir, 0o700);
  const databasePath = join(tempDir, "demo.sqlite");
  let child: ChildProcess;
  try {
    child = spawn(dependencies.bunPath, ["run", dependencies.serverBundle], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGENT_PROFILER_DB_PATH: databasePath,
        AGENT_PROFILER_PORT: "0",
        AGENT_PROFILER_HOST: "127.0.0.1",
        AGENT_PROFILER_DEMO: "true",
        AGENT_PROFILER_WEB_DIST: dependencies.webDist,
      },
    });
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  let resolveExit!: (result: ChildExit) => void;
  const exit = new Promise<ChildExit>((resolve) => { resolveExit = resolve; });
  child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-8_000); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_000); });
  child.once("error", (error) => { spawnError = error; resolveExit({ code: null, signal: null, error }); });
  child.once("exit", (code, signal) => resolveExit({ code, signal }));

  let requestedSignal: NodeJS.Signals | undefined;
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signalReceived = new Promise<NodeJS.Signals>((resolve) => { resolveSignal = resolve; });
  const onInterrupt = () => { requestedSignal = "SIGINT"; resolveSignal("SIGINT"); };
  const onTerminate = () => { requestedSignal = "SIGTERM"; resolveSignal("SIGTERM"); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    const deadline = Date.now() + 15_000;
    let url: string | undefined;
    while (Date.now() < deadline) {
      if (requestedSignal) throw new Error("Demo startup interrupted");
      if (spawnError) throw new Error(`Could not start Bun collector: ${spawnError.message}`);
      const childResult = await Promise.race([exit, wait(1).then(() => undefined)]);
      if (childResult) {
        throw new Error(`Demo collector exited before readiness (${childResult.code ?? childResult.signal}): ${stderr}`);
      }
      const portMatch = stdout.match(/agent-profiler listening on http:\/\/localhost:(\d+)/);
      if (portMatch) {
        url = `http://127.0.0.1:${portMatch[1]}`;
        try {
          const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
          const health = response.ok ? await response.json() as { demo?: boolean } : undefined;
          if (health?.demo === true) break;
        } catch { /* retry until ready or timeout */ }
        url = undefined;
      }
      await wait(50);
    }
    if (!url) throw new Error(`Demo collector did not become ready within 15 seconds. ${stderr}`);

    await seedDemo(url);
    console.log(`Demo ready: ${url}`);
    console.log("synthetic disposable data, real sessions unchanged");
    console.log("Press Ctrl-C to stop the demo and remove its temporary data.");
    if (options.open) openBrowser(url);

    const result = await Promise.race([exit, signalReceived.then((signal): ChildExit => ({ code: null, signal }))]);
    if (result.error) throw new Error(`Demo collector failed: ${result.error.message}`);
    if (requestedSignal) process.exitCode = requestedSignal === "SIGINT" ? 130 : 143;
    else if (result.code !== 0) {
      process.exitCode = result.code ?? 1;
      console.error(`Demo collector exited unexpectedly (${result.code ?? result.signal}).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await stopChild(child, exit);
    rmSync(tempDir, { recursive: true, force: true });
  }
}
