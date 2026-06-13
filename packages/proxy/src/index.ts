/**
 * Provider proxy (§4.2-C of PLAN.md)
 *
 * A localhost HTTP(S) proxy that sits between the LLM client (OpenCode,
 * VS Code Copilot, etc.) and the real provider endpoint.
 *
 * The proxy:
 *  1. Receives the full outgoing request body (system prompt, tool defs, messages).
 *  2. Forwards it to the real provider.
 *  3. Reads the response (including usage with cache counts).
 *  4. Emits an enriched OTLP-JSON span to the harness-profiler ingest endpoint
 *     so the cache and composition analyzers get ground-truth data.
 *
 * Usage:
 *   import { startProxy } from "@agent-profiler/proxy";
 *   startProxy({ port: 7071, targetBaseUrl: "https://api.anthropic.com", profilerEndpoint: "http://localhost:7070" });
 *
 * Then set your client's base_url to http://localhost:7071.
 */

export interface ProxyOptions {
  /** Port to listen on. Default: 7071 */
  port?: number;
  /** The real provider base URL, e.g. https://api.anthropic.com */
  targetBaseUrl: string;
  /** The harness-profiler OTLP endpoint, e.g. http://localhost:7070 */
  profilerEndpoint?: string;
  /** Optional session ID to tag spans with */
  sessionId?: string;
  /** Whether to log requests */
  verbose?: boolean;
}

export interface CapturedExchange {
  requestedAt: string;
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  latencyMs: number;
}

async function sha256hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse usage from various provider response shapes. */
function extractUsage(body: string): {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
} {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
  }

  // Anthropic shape
  const usage = (json.usage ?? json.usageMetadata ?? {}) as Record<string, unknown>;
  const promptTokens = Number(
    usage.input_tokens ?? usage.promptTokenCount ?? usage.prompt_tokens ?? 0
  );
  const completionTokens = Number(
    usage.output_tokens ?? usage.candidatesTokenCount ?? usage.completion_tokens ?? 0
  );

  // Anthropic cache fields
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  const cacheWriteTokens = Number(usage.cache_creation_input_tokens ?? 0);

  return { promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens, cost: 0 };
}

/** Emit a minimal OTLP JSON span to the profiler. */
async function emitSpan(
  exchange: CapturedExchange,
  profilerEndpoint: string,
  sessionId: string
): Promise<void> {
  const usage = extractUsage(exchange.responseBody);
  const spanId = await sha256hex(exchange.requestedAt + exchange.path).then((h) => h.slice(0, 16));
  const startNano = String(BigInt(new Date(exchange.requestedAt).getTime()) * 1_000_000n);
  const endNano = String(
    BigInt(new Date(exchange.requestedAt).getTime() + exchange.latencyMs) * 1_000_000n
  );

  function attr(key: string, value: string | number): object {
    if (typeof value === "number") {
      return { key, value: { intValue: String(value) } };
    }
    return { key, value: { stringValue: value } };
  }

  const span = {
    traceId: sessionId.replace(/-/g, "").padEnd(32, "0").slice(0, 32),
    spanId,
    parentSpanId: sessionId.replace(/-/g, "").slice(0, 16),
    name: `proxy:${exchange.path}`,
    startTimeUnixNano: startNano,
    endTimeUnixNano: endNano,
    attributes: [
      attr("openinference.span.kind", "LLM"),
      attr("session.id", sessionId),
      attr("llm.token_count.prompt", usage.promptTokens),
      attr("llm.token_count.completion", usage.completionTokens),
      attr("llm.token_count.prompt_details.cache_read", usage.cacheReadTokens),
      attr("llm.token_count.prompt_details.cache_write", usage.cacheWriteTokens),
      attr("proxy.request_body", exchange.requestBody.slice(0, 8192)),
      attr("proxy.response_body", exchange.responseBody.slice(0, 8192)),
    ],
  };

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "harness", value: { stringValue: "proxy" } },
            { key: "service.name", value: { stringValue: "provider-proxy" } },
          ],
        },
        scopeSpans: [{ spans: [span] }],
      },
    ],
  };

  try {
    await fetch(`${profilerEndpoint}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[proxy] failed to emit span to profiler:", e);
  }
}

/** Start the provider proxy. Returns the Bun server instance. */
export function startProxy(options: ProxyOptions) {
  const {
    port = 7071,
    targetBaseUrl,
    profilerEndpoint = "http://localhost:7070",
    sessionId = crypto.randomUUID(),
    verbose = false,
  } = options;

  const base = targetBaseUrl.replace(/\/$/, "");

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const targetUrl = `${base}${url.pathname}${url.search}`;

      const requestedAt = new Date().toISOString();
      const requestBody = await req.text();
      const startTime = Date.now();

      // Forward headers (strip hop-by-hop)
      const forwardHeaders: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (!["host", "connection", "transfer-encoding"].includes(lower)) {
          forwardHeaders[key] = value;
        }
      });
      // Ensure Content-Length is correct for new body
      forwardHeaders["Content-Length"] = String(new TextEncoder().encode(requestBody).byteLength);

      if (verbose) {
        console.log(`[proxy] → ${req.method} ${targetUrl} (${requestBody.length}B)`);
      }

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(targetUrl, {
          method: req.method,
          headers: forwardHeaders,
          body: requestBody || undefined,
        });
      } catch (err) {
        console.error("[proxy] upstream error:", err);
        return new Response("Proxy upstream error", { status: 502 });
      }

      const latencyMs = Date.now() - startTime;
      const responseBody = await upstreamRes.text();

      if (verbose) {
        console.log(`[proxy] ← ${upstreamRes.status} (${latencyMs}ms, ${responseBody.length}B)`);
      }

      // Emit span to profiler (fire and forget)
      const responseHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((v, k) => { responseHeaders[k] = v; });

      if (profilerEndpoint) {
        emitSpan(
          {
            requestedAt,
            method: req.method,
            path: url.pathname,
            requestHeaders: forwardHeaders,
            requestBody,
            responseStatus: upstreamRes.status,
            responseHeaders,
            responseBody,
            latencyMs,
          },
          profilerEndpoint,
          sessionId
        ).catch(console.error);
      }

      // Return the proxied response
      const responseForwardHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (!["transfer-encoding", "connection"].includes(lower)) {
          responseForwardHeaders[k] = v;
        }
      });

      return new Response(responseBody, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseForwardHeaders,
      });
    },
  });

  console.log(`[proxy] listening on http://localhost:${server.port} → ${base}`);
  return server;
}
