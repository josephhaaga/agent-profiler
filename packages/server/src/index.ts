import { ingestOtlpPayload } from "@agent-profiler/ingest";
import type { OtlpExportRequest } from "@agent-profiler/ingest";
import { analyzeCompare, runProfilers } from "@agent-profiler/profiler";
import { Store } from "@agent-profiler/store";
import { join } from "path";
import { homedir } from "os";

// Default DB path: ~/.agent-profiler/agent-profiler.sqlite so it persists across
// working directories when run via `agent-profiler start`. Overridable via env.
const DEFAULT_DB_PATH = join(homedir(), ".agent-profiler", "agent-profiler.sqlite");

const store = new Store({
  filePath: process.env.AGENT_PROFILER_DB_PATH ?? DEFAULT_DB_PATH,
});

const port = Number(process.env.AGENT_PROFILER_PORT ?? 7070);

// ── SSE live-tail clients ─────────────────────────────────────────────────────

type SseController = ReadableStreamDefaultController<string>;
const sseClients = new Set<SseController>();

function broadcast(type: string, data: unknown): void {
  const line = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(line);
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

// ── CORS helper ───────────────────────────────────────────────────────────────

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function notFound(msg = "Not found"): Response {
  return new Response(msg, { status: 404, headers: corsHeaders() });
}

// ── Static SPA serving ────────────────────────────────────────────────────────

// AGENT_PROFILER_WEB_DIST lets the CLI (or any other launcher) override where
// the pre-built SPA lives without recompiling the server. Falls back to the
// monorepo-relative path for local dev.
const WEB_DIST =
  process.env.AGENT_PROFILER_WEB_DIST ?? join(import.meta.dir, "../../web/dist");

async function serveStatic(pathname: string): Promise<Response | null> {
  // strip leading /
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidates = [
    join(WEB_DIST, rel),
    join(WEB_DIST, rel, "index.html"),
    join(WEB_DIST, "index.html"), // SPA fallback
  ];

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const mimeMap: Record<string, string> = {
        html: "text/html",
        js: "application/javascript",
        css: "text/css",
        svg: "image/svg+xml",
        png: "image/png",
        ico: "image/x-icon",
        json: "application/json",
        woff2: "font/woff2",
      };
      const ext = candidate.split(".").pop() ?? "";
      const mime = mimeMap[ext] ?? "application/octet-stream";
      return new Response(file, {
        headers: { "Content-Type": mime, ...corsHeaders() },
      });
    }
  }
  return null;
}

// ── Request router ────────────────────────────────────────────────────────────

const server = Bun.serve({
  port,

  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Health ──────────────────────────────────────────────────────────────

    if (pathname === "/healthz") {
      return json({ ok: true, name: "agent-profiler", version: "0.1.0" });
    }

    // ── OTLP ingest ─────────────────────────────────────────────────────────

    if (pathname === "/v1/traces" && req.method === "POST") {
      const contentType = req.headers.get("content-type") ?? "";
      let payload: OtlpExportRequest;

      try {
        if (contentType.includes("application/x-protobuf")) {
          // Decode proto: for now, we expect the sender (opencode-openinference)
          // to also support JSON mode. Many libraries do. Return 415 hint otherwise.
          return new Response(
            "Proto-binary OTLP not yet supported; set content-type application/json",
            { status: 415, headers: corsHeaders() }
          );
        }

        const text = await req.text();
        payload = JSON.parse(text) as OtlpExportRequest;
      } catch (err) {
        console.error("[ingest] failed to parse OTLP payload:", err);
        return new Response("Bad request", { status: 400, headers: corsHeaders() });
      }

      try {
        const result = await ingestOtlpPayload(payload, store, (event) => broadcast(event.type, event.data));
        console.log(`[ingest] sessions=${result.sessionsUpserted} turns=${result.turnsUpserted} llm=${result.llmCallsUpserted} tools=${result.toolCallsUpserted}`);

        // Run profilers for each new session (fire and forget)
        for (const rs of payload.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const span of ss.spans ?? []) {
              const attrs: Record<string, unknown> = {};
              for (const kv of span.attributes ?? []) {
                if ("stringValue" in kv.value) attrs[kv.key] = kv.value.stringValue;
              }
              const sessionId = String(attrs["session.id"] ?? span.spanId);
              runProfilers(sessionId, store).then((insights) => {
                for (const insight of insights) broadcast("insight", insight);
              }).catch((e: unknown) => console.error("[profiler]", e));
            }
          }
        }
      } catch (err) {
        console.error("[ingest] error processing OTLP payload:", err);
        return new Response("Internal error", { status: 500, headers: corsHeaders() });
      }

      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Sessions API ─────────────────────────────────────────────────────────

    if (pathname === "/api/sessions" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json({ sessions: store.listSessions(limit) });
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const id = sessionMatch[1]!;
      const session = store.getSession(id);
      return session ? json({ session }) : notFound();
    }

    const sessionTurnsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
    if (sessionTurnsMatch && req.method === "GET") {
      const id = sessionTurnsMatch[1]!;
      return json({ turns: store.listTurns(id) });
    }

    const sessionInsightsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/insights$/);
    if (sessionInsightsMatch && req.method === "GET") {
      const id = sessionInsightsMatch[1]!;
      return json({ insights: store.listInsights("session", id) });
    }

    // ── Turns API ────────────────────────────────────────────────────────────

    const turnMatch = pathname.match(/^\/api\/turns\/([^/]+)$/);
    if (turnMatch && req.method === "GET") {
      const id = turnMatch[1]!;
      const turn = store.getTurn(id);
      return turn ? json({ turn }) : notFound();
    }

    const turnLlmMatch = pathname.match(/^\/api\/turns\/([^/]+)\/llm-calls$/);
    if (turnLlmMatch && req.method === "GET") {
      const id = turnLlmMatch[1]!;
      return json({ llmCalls: store.listLlmCalls(id) });
    }

    const turnToolsMatch = pathname.match(/^\/api\/turns\/([^/]+)\/tool-calls$/);
    if (turnToolsMatch && req.method === "GET") {
      const id = turnToolsMatch[1]!;
      return json({ toolCalls: store.listToolCalls(id) });
    }

    // ── LLM Calls API ─────────────────────────────────────────────────────────

    const llmCallSegmentsMatch = pathname.match(/^\/api\/llm-calls\/([^/]+)\/segments$/);
    if (llmCallSegmentsMatch && req.method === "GET") {
      const id = llmCallSegmentsMatch[1]!;
      return json({ segments: store.listPromptSegments(id) });
    }

    // ── Blobs API ─────────────────────────────────────────────────────────────

    const blobMatch = pathname.match(/^\/api\/blobs\/([a-f0-9]+)$/);
    if (blobMatch && req.method === "GET") {
      const ref = blobMatch[1]!;
      const blob = store.getBlob(ref);
      if (!blob) return notFound();
      return new Response(blob.bytes, {
        headers: { "Content-Type": blob.mime, ...corsHeaders() },
      });
    }

    // ── Insights API ──────────────────────────────────────────────────────────

    if (pathname === "/api/insights" && req.method === "GET") {
      const scopeType = url.searchParams.get("scopeType") ?? undefined;
      const scopeId = url.searchParams.get("scopeId") ?? undefined;
      return json({ insights: store.listInsights(scopeType, scopeId) });
    }

    // ── Compare API ───────────────────────────────────────────────────────────

    if (pathname === "/api/compare" && req.method === "GET") {
      const harnesses = url.searchParams.get("harnesses")?.split(",") ?? undefined;
      return json({ compare: analyzeCompare(store, harnesses) });
    }

    // ── Profile on-demand ─────────────────────────────────────────────────────

    const profileMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/profile$/);
    if (profileMatch && req.method === "POST") {
      const id = profileMatch[1]!;
      const insights = await runProfilers(id, store);
      return json({ insights });
    }

    // ── SSE live tail ─────────────────────────────────────────────────────────

    if (pathname === "/api/stream" && req.method === "GET") {
      let ctrl: SseController;
      const stream = new ReadableStream<string>({
        start(c) {
          ctrl = c;
          sseClients.add(ctrl);
          // Send a heartbeat immediately
          ctrl.enqueue(": heartbeat\n\n");
        },
        cancel() {
          sseClients.delete(ctrl);
        },
      });

      // Send keep-alive every 15s
      const interval = setInterval(() => {
        try {
          ctrl.enqueue(": heartbeat\n\n");
        } catch {
          clearInterval(interval);
        }
      }, 15_000);

      return new Response(stream as unknown as ReadableStream<Uint8Array>, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // ── SPA static files ──────────────────────────────────────────────────────

    const staticResponse = await serveStatic(pathname);
    if (staticResponse) return staticResponse;

    return notFound();
  },
});

console.log(`agent-profiler listening on http://localhost:${server.port}`);
console.log(`  OTLP endpoint: http://localhost:${server.port}/v1/traces`);
console.log(`  Web UI:        http://localhost:${server.port}/`);
