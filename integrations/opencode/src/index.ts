/**
 * @harness-profiler/opencode — LM-middleware capture (§4.2-B of PLAN.md)
 *
 * This integration adds enriched span attributes to the OTLP traces that
 * opencode-openinference already emits. It wraps the language model to
 * capture what openinference can't: full tool definitions and the
 * segmented system prompt.
 *
 * Usage (in your opencode.json / plugin config):
 *
 *   import { createHarnessProfilerMiddleware } from "@harness-profiler/opencode";
 *
 *   export default {
 *     experimental: {
 *       chat: {
 *         system: {
 *           transform(chunks) { return chunks; }, // optional
 *         },
 *       },
 *     },
 *     plugins: [createHarnessProfilerMiddleware()],
 *   };
 *
 * The middleware intercepts wrapLanguageModel calls and:
 *  1. Reads args.params.system / args.params.messages to segment the prompt.
 *  2. Reads args.params.tools (or prepared.tools) for tool definitions.
 *  3. Adds prompt.segments, llm.tools.definitions, prompt.static_prefix.sha256
 *     as span attributes on the LLM span so the profiler can use them.
 *
 * NOTE: This uses OpenCode-internal APIs that may change. The profiler
 * degrades gracefully if these attributes are absent.
 */

export interface HarnessProfilerOptions {
  /** If true, log captured data sizes to console. Default: false. */
  verbose?: boolean;
}

// ── Minimal types we need from the AI SDK / OpenCode internals ────────────────

interface Message {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

interface Tool {
  name?: string;
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
}

interface LLMParams {
  system?: string | string[];
  messages?: Message[];
  tools?: Record<string, Tool> | Tool[];
  prompt?: string;
}

interface LLMCallArgs {
  params?: LLMParams;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sha256hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Segment extractor ─────────────────────────────────────────────────────────

export interface SegmentInfo {
  ord: number;
  source_kind: string;
  source_name: string;
  char_len: number;
  sha256: string;
  token_est: number;
  is_static: boolean;
}

/**
 * Extract prompt segments from the system array.
 *
 * OpenCode assembles a string[] from:
 *  - instructions (static)
 *  - agent.prompt (static)
 *  - input.system / user.system (dynamic per turn)
 *
 * We can't reliably attribute individual chunks here since they've been
 * joined, but we parse the combined string and produce one unattributed
 * segment. If the caller passes labelled chunks (§4.2-A hook), we use them.
 */
export async function extractSegments(
  system: string | string[] | undefined,
  labels?: Array<{ kind: string; name: string }>
): Promise<SegmentInfo[]> {
  if (!system) return [];

  const chunks = Array.isArray(system) ? system : [system];
  const results: SegmentInfo[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i] ?? "";
    if (!text.trim()) continue;
    const hash = await sha256hex(text);
    const label = labels?.[i];
    results.push({
      ord: i,
      source_kind: label?.kind ?? "system",
      source_name: label?.name ?? `system[${i}]`,
      char_len: text.length,
      sha256: hash,
      token_est: estimateTokens(text),
      is_static: i === 0, // heuristic: first chunk is usually the static instructions
    });
  }

  return results;
}

// ── Tool def extractor ────────────────────────────────────────────────────────

export interface ToolDefInfo {
  name: string;
  kind: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export function extractToolDefs(tools: LLMParams["tools"] | undefined): ToolDefInfo[] {
  if (!tools) return [];

  const defs: ToolDefInfo[] = [];

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      defs.push({
        name: tool.name ?? "unknown",
        kind: inferToolKind(tool.name ?? ""),
        description: tool.description,
        schema: (tool.parameters ?? tool.inputSchema) as Record<string, unknown> | undefined,
      });
    }
  } else {
    for (const [name, tool] of Object.entries(tools)) {
      defs.push({
        name,
        kind: inferToolKind(name),
        description: tool.description,
        schema: (tool.parameters ?? tool.inputSchema) as Record<string, unknown> | undefined,
      });
    }
  }

  return defs;
}

function inferToolKind(name: string): string {
  if (name.includes(":") || name.startsWith("mcp")) return "mcp";
  if (name.startsWith("skill")) return "skill";
  return "builtin";
}

// ── Static prefix hash ────────────────────────────────────────────────────────

export async function computeStaticPrefixHash(segments: SegmentInfo[]): Promise<string> {
  const staticSegs = segments.filter((s) => s.is_static);
  const combined = staticSegs.map((s) => s.sha256).join("|");
  return sha256hex(combined);
}

// ── Middleware factory ────────────────────────────────────────────────────────

export interface SpanAttributes {
  "prompt.segments": string;
  "llm.tools.definitions": string;
  "prompt.static_prefix.sha256": string;
  "prompt.static_prefix.tokens": number;
}

/**
 * Intercept an LLM call and produce the enriched span attributes.
 *
 * In OpenCode, this is called from the LM-middleware layer (§4.2-B):
 *
 *   const middleware = createHarnessProfilerMiddleware();
 *   const result = await middleware.transformParams(args);
 *   // set result.spanAttributes on the current span
 */
export function createHarnessProfilerMiddleware(options: HarnessProfilerOptions = {}) {
  const { verbose = false } = options;

  return {
    /**
     * Called before each LLM request. Extracts segments + tool defs and
     * returns enriched attributes to be added to the active OTLP span.
     */
    async transformParams(args: LLMCallArgs): Promise<SpanAttributes> {
      const params = args.params ?? {};

      const segments = await extractSegments(params.system);
      const toolDefs = extractToolDefs(params.tools);
      const staticPrefixHash = await computeStaticPrefixHash(segments);
      const staticPrefixTokens = segments
        .filter((s) => s.is_static)
        .reduce((sum, s) => sum + s.token_est, 0);

      if (verbose) {
        console.log(
          `[harness-profiler] segments=${segments.length} tools=${toolDefs.length} prefix=${staticPrefixHash.slice(0, 8)}`
        );
      }

      return {
        "prompt.segments": JSON.stringify(segments),
        "llm.tools.definitions": JSON.stringify(toolDefs),
        "prompt.static_prefix.sha256": staticPrefixHash,
        "prompt.static_prefix.tokens": staticPrefixTokens,
      };
    },
  };
}
