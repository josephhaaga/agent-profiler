/**
 * TOOL span builder. One per tool/MCP/skill call (keyed by callID).
 * See DESIGN.md §4 (Tool/MCP/skill) and §6.4.
 */
import {
  type Span,
  type Tracer,
  type Context,
  SpanStatusCode,
  trace,
  context as otelContext,
} from "@opentelemetry/api";
import {
  SemanticConventions,
  OpenInferenceSpanKind,
  MimeType,
} from "@arizeai/openinference-semantic-conventions";
import type { ResolvedConfig } from "../config.js";
import { classifyTool, type ToolIdentity } from "../identity.js";
import { setStr, safeJson, toValueAndMime } from "../attributes.js";

export interface OpenToolArgs {
  tracer: Tracer;
  parent: Span;
  sessionID: string;
  tool: string;
  callID: string;
  args?: unknown;
  mcpServers?: ReadonlySet<string>;
  config: ResolvedConfig;
}

export interface OpenToolResult {
  span: Span;
  identity: ToolIdentity;
}

export function openToolSpan(opts: OpenToolArgs): OpenToolResult {
  const { tracer, parent, sessionID, tool, callID, args, mcpServers, config } = opts;
  const identity = classifyTool({ tool, args, mcpServers });

  const ctx: Context = trace.setSpan(otelContext.active(), parent);
  const span = tracer.startSpan(identity.displayName, undefined, ctx);

  span.setAttribute(
    SemanticConventions.OPENINFERENCE_SPAN_KIND,
    OpenInferenceSpanKind.TOOL,
  );
  span.setAttribute(SemanticConventions.SESSION_ID, sessionID);
  span.setAttribute(SemanticConventions.TOOL_NAME, identity.displayName);
  span.setAttribute(SemanticConventions.TOOL_ID, callID);
  if (identity.tags.length > 0) {
    span.setAttribute(SemanticConventions.TAG_TAGS, identity.tags);
  }

  if (config.captureContent && !config.hideInputs && args !== undefined) {
    const argsJson = safeJson(args);
    setStr(span, SemanticConventions.TOOL_PARAMETERS, argsJson, config.maxAttrChars);
    setStr(span, SemanticConventions.INPUT_VALUE, argsJson, config.maxAttrChars);
    span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, MimeType.JSON);
  }

  return { span, identity };
}

export interface CloseToolArgs {
  identity: ToolIdentity;
  output?: string;
  metadata?: unknown;
  errored?: boolean;
  config: ResolvedConfig;
}

export function closeToolSpan(span: Span, args: CloseToolArgs): void {
  const { identity, output, metadata, errored, config } = args;

  const redacted =
    identity.kind !== "skill" &&
    config.redactToolOutputs.some((name) => name === identity.displayName);

  if (config.captureContent && !config.hideOutputs && output !== undefined && !redacted) {
    const { value, mime } = toValueAndMime(output);
    setStr(span, SemanticConventions.OUTPUT_VALUE, value, config.maxAttrChars);
    span.setAttribute(
      SemanticConventions.OUTPUT_MIME_TYPE,
      mime === "application/json" ? MimeType.JSON : MimeType.TEXT,
    );
  }

  if (metadata !== undefined && metadata !== null) {
    setStr(span, SemanticConventions.METADATA, safeJson(metadata), config.maxAttrChars);
  }

  span.setStatus({ code: errored ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
