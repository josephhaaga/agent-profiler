/**
 * Session-level CHAIN span (the trace root). One per OpenCode session.
 */
import { type Span, type Tracer, SpanStatusCode } from "@opentelemetry/api";
import {
  SemanticConventions,
  OpenInferenceSpanKind,
} from "@arizeai/openinference-semantic-conventions";
import type { ResolvedConfig } from "../config.js";
import { setStr } from "../attributes.js";

export interface OpenSessionArgs {
  tracer: Tracer;
  sessionID: string;
  agent?: string;
  userId?: string;
  config: ResolvedConfig;
}

export function openSessionSpan(args: OpenSessionArgs): Span {
  const { tracer, sessionID, agent, userId, config } = args;
  const span = tracer.startSpan(`session ${sessionID}`);
  span.setAttribute(
    SemanticConventions.OPENINFERENCE_SPAN_KIND,
    OpenInferenceSpanKind.CHAIN,
  );
  span.setAttribute(SemanticConventions.SESSION_ID, sessionID);
  setStr(span, SemanticConventions.AGENT_NAME, agent, config.maxAttrChars);
  if (userId && config.captureContent) {
    setStr(span, SemanticConventions.USER_ID, userId, config.maxAttrChars);
  }
  return span;
}

export function closeSessionSpan(span: Span, errored = false): void {
  span.setStatus({ code: errored ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
