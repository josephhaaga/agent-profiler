/**
 * LLM span builder. The rich span: prompts, responses, tokens, cost, params.
 * See DESIGN.md §4 (LLM call) and §6.6.
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
} from "@arizeai/openinference-semantic-conventions";
import type { ResolvedConfig } from "../config.js";
import type { AssistantMessage } from "../types.js";
import type { OIMessage } from "../messages.js";
import { mapProvider } from "../identity.js";
import { setStr, setNum, safeJson } from "../attributes.js";

export interface OpenLlmArgs {
  tracer: Tracer;
  parent: Span;
  sessionID: string;
  modelID: string;
  providerID: string;
  invocationParams?: Record<string, unknown>;
  config: ResolvedConfig;
}

export function openLlmSpan(args: OpenLlmArgs): Span {
  const { tracer, parent, sessionID, modelID, providerID, invocationParams, config } = args;
  const ctx: Context = trace.setSpan(otelContext.active(), parent);
  const span = tracer.startSpan(`chat ${modelID}`, undefined, ctx);

  span.setAttribute(
    SemanticConventions.OPENINFERENCE_SPAN_KIND,
    OpenInferenceSpanKind.LLM,
  );
  span.setAttribute(SemanticConventions.SESSION_ID, sessionID);
  span.setAttribute(SemanticConventions.LLM_MODEL_NAME, modelID);

  const { provider, system } = mapProvider(providerID);
  span.setAttribute(SemanticConventions.LLM_PROVIDER, provider);
  if (system) span.setAttribute(SemanticConventions.LLM_SYSTEM, system);

  if (invocationParams && Object.keys(invocationParams).length > 0) {
    setStr(
      span,
      SemanticConventions.LLM_INVOCATION_PARAMETERS,
      safeJson(invocationParams),
      config.maxAttrChars,
    );
  }
  return span;
}

/** Attach the input messages (system + conversation) to an open LLM span. */
export function setLlmInputMessages(
  span: Span,
  messages: OIMessage[],
  config: ResolvedConfig,
): void {
  if (!config.captureContent || config.hideInputMessages) return;
  messages.forEach((m, i) => {
    const base = `${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_ROLE}`;
    span.setAttribute(base, m.role);
    if (m.content !== undefined) {
      setStr(
        span,
        `${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_CONTENT}`,
        m.content,
        config.maxAttrChars,
      );
    }
    (m.toolCalls ?? []).forEach((tc, j) => {
      const tcBase = `${SemanticConventions.LLM_INPUT_MESSAGES}.${i}.${SemanticConventions.MESSAGE_TOOL_CALLS}.${j}`;
      if (tc.id) span.setAttribute(`${tcBase}.${SemanticConventions.TOOL_CALL_ID}`, tc.id);
      if (tc.name)
        span.setAttribute(`${tcBase}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`, tc.name);
      if (tc.argumentsJson)
        setStr(
          span,
          `${tcBase}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`,
          tc.argumentsJson,
          config.maxAttrChars,
        );
    });
  });
}

export interface CloseLlmArgs {
  assistant: AssistantMessage;
  outputMessage?: OIMessage;
  config: ResolvedConfig;
}

/** Finalize an LLM span from the terminal AssistantMessage. */
export function closeLlmSpan(span: Span, args: CloseLlmArgs): void {
  const { assistant, outputMessage, config } = args;
  const t = assistant.tokens;

  // Output message (assistant text + any tool calls the model emitted).
  if (config.captureContent && !config.hideOutputMessages && outputMessage) {
    const base = `${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_ROLE}`;
    span.setAttribute(base, outputMessage.role);
    if (outputMessage.content !== undefined) {
      setStr(
        span,
        `${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_CONTENT}`,
        outputMessage.content,
        config.maxAttrChars,
      );
    }
    (outputMessage.toolCalls ?? []).forEach((tc, j) => {
      const tcBase = `${SemanticConventions.LLM_OUTPUT_MESSAGES}.0.${SemanticConventions.MESSAGE_TOOL_CALLS}.${j}`;
      if (tc.id) span.setAttribute(`${tcBase}.${SemanticConventions.TOOL_CALL_ID}`, tc.id);
      if (tc.name)
        span.setAttribute(`${tcBase}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`, tc.name);
      if (tc.argumentsJson)
        setStr(
          span,
          `${tcBase}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`,
          tc.argumentsJson,
          config.maxAttrChars,
        );
    });
  }

  // Tokens.
  if (t) {
    setNum(span, SemanticConventions.LLM_TOKEN_COUNT_PROMPT, t.input);
    setNum(span, SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, t.output);
    const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    setNum(span, SemanticConventions.LLM_TOKEN_COUNT_TOTAL, total);
    setNum(
      span,
      SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING,
      t.reasoning,
    );
    setNum(
      span,
      SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
      t.cache?.read,
    );
    setNum(
      span,
      SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
      t.cache?.write,
    );
  }

  // Cost (total only; OpenCode does not itemize splits).
  setNum(span, SemanticConventions.LLM_COST_TOTAL, assistant.cost);

  // Metadata.
  setStr(
    span,
    SemanticConventions.METADATA,
    safeJson({ finish: assistant.finish, messageID: assistant.id }),
    config.maxAttrChars,
  );

  const errored = Boolean(assistant.error);
  span.setStatus({ code: errored ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
