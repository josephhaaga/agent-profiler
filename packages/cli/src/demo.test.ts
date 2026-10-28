import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const cli = join(import.meta.dir, "../dist/index.js");
const testRoot = mkdtempSync(join(tmpdir(), "agent-profiler-demo-test-"));
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

function runCli(args: string[]) {
  return Bun.spawn([cli, ...args], {
    env: { ...process.env, TMPDIR: testRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function drain(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    onText(decoder.decode(value));
  }
}

test("demo runs an isolated seeded collector and removes its temporary state on SIGTERM", async () => {
  const child = runCli(["demo", "--no-open"]);
  let output = "";
  let errorOutput = "";
  const stdoutPromise = drain(child.stdout, (text) => { output += text; });
  const stderrPromise = drain(child.stderr, (text) => { errorOutput += text; });
  try {
    const deadline = Date.now() + 20_000;
    while (!output.includes("http://127.0.0.1:")) {
      if (child.exitCode !== null) {
        await Promise.all([stdoutPromise, stderrPromise]);
        throw new Error(`demo exited before readiness (${child.exitCode}): ${errorOutput}`);
      }
      if (Date.now() >= deadline) throw new Error(`demo did not become ready: ${errorOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    expect(output).toContain("synthetic disposable data, real sessions unchanged");
    expect(await (await fetch(`${url}/healthz`)).json()).toMatchObject({ ok: true, demo: true });

    const { sessions } = await (await fetch(`${url}/api/sessions?limit=100`)).json();
    expect(sessions.map((session: { id: string }) => session.id).sort()).toEqual([
      "ses_demo_ordinary",
      "ses_demo_tool_error",
      "ses_demo_partial_usage",
    ].sort());
    const toolErrorSession = sessions.find((session: { id: string }) => session.id === "ses_demo_tool_error");
    const { turns } = await (await fetch(`${url}/api/sessions/${toolErrorSession.id}/turns`)).json();
    const { toolCalls } = await (await fetch(`${url}/api/turns/${turns[0].id}/tool-calls`)).json();
    expect(toolCalls[0].status).toBe("ERROR");
    const partialSession = sessions.find((session: { id: string }) => session.id === "ses_demo_partial_usage");
    const partialTurnsResponse = await (await fetch(`${url}/api/sessions/${partialSession.id}/turns`)).json();
    const { llmCalls } = await (await fetch(`${url}/api/turns/${partialTurnsResponse.turns[0].id}/llm-calls`)).json();
    expect(llmCalls[0].capture.unknownMetrics).toContain("promptTokens");

    expect(readdirSync(testRoot)).toHaveLength(1);
    child.kill("SIGTERM");
    await child.exited;
    await stdoutPromise;
    await stderrPromise;
    expect(readdirSync(testRoot)).toHaveLength(0);
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    await Promise.all([stdoutPromise, stderrPromise]);
  }
});

test("demo rejects unknown flags without creating temporary state", async () => {
  const child = runCli(["demo", "--unexpected"]);
  let output = "";
  const [stdoutDone, stderrDone] = [
    drain(child.stdout, (text) => { output += text; }),
    drain(child.stderr, (text) => { output += text; }),
  ];
  const exitCode = await child.exited;
  await Promise.all([stdoutDone, stderrDone]);
  expect(exitCode).toBe(1);
  expect(output).toContain("Unknown demo option");
  expect(readdirSync(testRoot)).toHaveLength(0);
});
