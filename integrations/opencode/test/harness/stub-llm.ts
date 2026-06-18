/**
 * Scripted stub OpenAI-compatible LLM server.
 *
 * Implements just enough of the OpenAI Chat Completions API to satisfy opencode:
 *   GET  /v1/models                — returns the configured model id
 *   POST /v1/chat/completions      — streams/returns a canned scenario response
 *
 * Scenarios are loaded from test/harness/scenarios/<name>.json. The default
 * scenario ("tool-call-then-text") produces one tool-call turn followed by a
 * text response turn so both LLM and tool spans get emitted.
 *
 * Usage:
 *   bun run integrations/opencode/test/harness/stub-llm.ts [--port 0] [--scenario tool-call-then-text]
 *
 * The server prints its bound port to stdout as JSON: { "port": <n> }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioTurn {
  /** Optional tool calls to emit before the final text response. */
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  /** Final text content (used when no tool_calls, or as the follow-up). */
  content?: string;
  /** Token usage to report. */
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Cache read tokens (maps to cached_tokens in openai format). */
    cache_read_tokens?: number;
  };
  /** Cost reported via system fields (optional, for golden-file assertions). */
  cost?: { input: number; output: number; total: number };
}

export interface Scenario {
  model: string;
  turns: ScenarioTurn[];
}

// ---------------------------------------------------------------------------
// Default scenario
// ---------------------------------------------------------------------------

const DEFAULT_SCENARIO: Scenario = {
  model: "stub-model",
  turns: [
    {
      // Turn 1: agent calls a tool
      tool_calls: [
        {
          id: "call_abc123",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "echo hello" }),
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145, cache_read_tokens: 40 },
    },
    {
      // Turn 2: agent responds with text after tool result
      content: "The command output is: hello",
      usage: { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210, cache_read_tokens: 80 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

let scenario: Scenario = DEFAULT_SCENARIO;
// Tracks which scenario turn we are on (resets per server lifetime).
let turnIndex = 0;

function loadScenario(name: string, scenarioDir: string): void {
  try {
    const path = join(scenarioDir, `${name}.json`);
    const raw = readFileSync(path, "utf8");
    scenario = JSON.parse(raw) as Scenario;
    console.error(`[stub-llm] loaded scenario: ${name} (${scenario.turns.length} turns)`);
  } catch {
    console.error(`[stub-llm] scenario '${name}' not found, using default`);
  }
}

// ---------------------------------------------------------------------------
// SSE streaming helpers
// ---------------------------------------------------------------------------

function makeChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeDoneChunk(): string {
  return "data: [DONE]\n\n";
}

function buildStreamingResponse(turn: ScenarioTurn, model: string): string {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunks: string[] = [];

  if (turn.tool_calls && turn.tool_calls.length > 0) {
    // Emit tool call deltas
    const tc = turn.tool_calls[0];
    chunks.push(makeChunk({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }, finish_reason: null }],
    }));
    // Stream arguments in one chunk
    chunks.push(makeChunk({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] }, finish_reason: null }],
    }));
    // Finish tool_calls
    chunks.push(makeChunk({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: turn.usage.prompt_tokens,
        completion_tokens: turn.usage.completion_tokens,
        total_tokens: turn.usage.total_tokens,
        prompt_tokens_details: { cached_tokens: turn.usage.cache_read_tokens ?? 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
    }));
  } else {
    // Emit text content
    const text = turn.content ?? "";
    // role chunk
    chunks.push(makeChunk({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }));
    // content chunk (one shot)
    chunks.push(makeChunk({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }));
    // stop chunk with usage
    chunks.push(makeChunk({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: turn.usage.prompt_tokens,
        completion_tokens: turn.usage.completion_tokens,
        total_tokens: turn.usage.total_tokens,
        prompt_tokens_details: { cached_tokens: turn.usage.cache_read_tokens ?? 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
    }));
  }

  chunks.push(makeDoneChunk());
  return chunks.join("");
}

function buildNonStreamingResponse(turn: ScenarioTurn, model: string): unknown {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);

  if (turn.tool_calls && turn.tool_calls.length > 0) {
    const tc = turn.tool_calls[0];
    return {
      id, object: "chat.completion", created, model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: turn.usage.prompt_tokens,
        completion_tokens: turn.usage.completion_tokens,
        total_tokens: turn.usage.total_tokens,
        prompt_tokens_details: { cached_tokens: turn.usage.cache_read_tokens ?? 0 },
      },
    };
  }

  return {
    id, object: "chat.completion", created, model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: turn.content ?? "" },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: turn.usage.prompt_tokens,
      completion_tokens: turn.usage.completion_tokens,
      total_tokens: turn.usage.total_tokens,
      prompt_tokens_details: { cached_tokens: turn.usage.cache_read_tokens ?? 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Bun HTTP server
// ---------------------------------------------------------------------------

export function createStubLlmServer(opts: { port?: number; scenario?: Scenario } = {}): {
  server: ReturnType<typeof Bun.serve>;
  url: string;
} {
  if (opts.scenario) {
    scenario = opts.scenario;
    turnIndex = 0;
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);

      // --- GET /v1/models ---
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: scenario.model, object: "model", created: 0, owned_by: "stub" }],
        });
      }

      // --- POST /v1/chat/completions ---
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const turn = scenario.turns[turnIndex % scenario.turns.length];
        turnIndex++;

        const wantsStream = req.headers.get("accept")?.includes("text/event-stream") ||
          req.url.includes("stream=true");

        // Check request body for stream flag (ai-sdk sends it in body)
        const isStream = wantsStream; // will refine below

        return new Promise<Response>((resolve) => {
          req.json().then((body: unknown) => {
            const b = body as { stream?: boolean };
            const streaming = b?.stream ?? isStream;

            if (streaming) {
              const sseBody = buildStreamingResponse(turn, scenario.model);
              resolve(new Response(sseBody, {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                },
              }));
            } else {
              resolve(Response.json(buildNonStreamingResponse(turn, scenario.model)));
            }
          }).catch(() => {
            // fallback: non-streaming
            resolve(Response.json(buildNonStreamingResponse(turn, scenario.model)));
          });
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return { server, url: `http://localhost:${server.port}` };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Run directly via `bun run stub-llm.ts`
if (import.meta.main) {
  const args = process.argv.slice(2);
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 0;
  const scenarioName = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : undefined;
  const scenarioDir = args.includes("--scenario-dir") ? args[args.indexOf("--scenario-dir") + 1] : join(import.meta.dir, "scenarios");

  if (scenarioName) {
    loadScenario(scenarioName, scenarioDir);
  }

  const { server, url } = createStubLlmServer({ port });
  // Print port as JSON so the launcher can parse it.
  console.log(JSON.stringify({ port: server.port, url }));
  console.error(`[stub-llm] listening on ${url} (model=${scenario.model})`);

  // Keep alive — launcher sends SIGTERM to stop.
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
  process.on("SIGINT", () => {
    server.stop(true);
    process.exit(0);
  });
}
