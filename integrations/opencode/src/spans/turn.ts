/**
 * Turn-level CHAIN span. One per user→assistant turn, nested under the session.
 * Groups all LLM round-trips + tool calls for a single user request so cost and
 * latency are attributable per request. Optional (config.emitTurnSpans).
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
import { setStr, safeJson } from "../attributes.js";

export interface OpenTurnArgs {
  tracer: Tracer;
  parent: Span;
  sessionID: string;
  messageID: string;
  agent?: string;
  model?: string;
  promptText?: string;
  config: ResolvedConfig;
}

export function openTurnSpan(args: OpenTurnArgs): Span {
  const { tracer, parent, sessionID, messageID, agent, model, promptText, config } = args;
  const ctx: Context = trace.setSpan(otelContext.active(), parent);
  const span = tracer.startSpan(`turn ${messageID}`, undefined, ctx);
  span.setAttribute(
    SemanticConventions.OPENINFERENCE_SPAN_KIND,
    OpenInferenceSpanKind.CHAIN,
  );
  span.setAttribute(SemanticConventions.SESSION_ID, sessionID);
  span.setAttribute(
    SemanticConventions.METADATA,
    safeJson({ messageID, agent, model }),
  );
  if (config.captureContent && !config.hideInputs && promptText) {
    setStr(span, SemanticConventions.INPUT_VALUE, promptText, config.maxAttrChars);
    span.setAttribute(SemanticConventions.INPUT_MIME_TYPE, MimeType.TEXT);
  }
  return span;
}

export function closeTurnSpan(
  span: Span,
  opts: { outputText?: string; errored?: boolean; config: ResolvedConfig },
): void {
  const { outputText, errored, config } = opts;
  if (config.captureContent && !config.hideOutputs && outputText) {
    setStr(span, SemanticConventions.OUTPUT_VALUE, outputText, config.maxAttrChars);
    span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
  }
  span.setStatus({ code: errored ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
