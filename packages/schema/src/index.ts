export type HarnessKind = "opencode" | "vscode" | "custom";

export type SpanKind = "session" | "turn" | "llm" | "tool";

export interface SpanBody {
  id: string;
  kind: SpanKind;
  sessionId: string;
  turnId?: string;
  parentId?: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  attributes: Record<string, unknown>;
}

export interface PromptSegment {
  order: number;
  sourceKind: string;
  sourceName: string;
  text: string;
  sha256: string;
  charLen: number;
  tokenEstimate?: number;
}

export interface ToolDefinition {
  name: string;
  kind: "builtin" | "mcp" | "skill" | "other";
  schema: Record<string, unknown>;
  description?: string;
  sha256: string;
  tokenEstimate?: number;
}

export interface SessionRecord {
  id: string;
  title?: string;
  harness: HarnessKind;
  agent?: string;
  model?: string;
  project?: string;
  startedAt: string;
  endedAt?: string;
  turnCount: number;
  llmCallCount: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costTotal: number;
  endReason?: string;
  toolErrorCount?: number;
  modelErrorCount?: number;
  turnErrorCount?: number;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  idx: number;
  userText?: string;
  assistantText?: string;
  startedAt: string;
  endedAt?: string;
  llmRoundTrips: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  status?: string;
  endSignal?: "completed" | "user_stopped" | "error";
}

export interface LlmCallRecord {
  id: string;
  turnId: string;
  sessionId: string;
  model: string;
  provider?: string;
  paramsJson?: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  latencyMs: number;
  finishReason?: string;
  inputMessagesRef?: string;
  outputRef?: string;
}

export interface ToolCallRecord {
  id: string;
  turnId: string;
  sessionId: string;
  name: string;
  kind: "builtin" | "mcp" | "skill" | "other";
  server?: string;
  skill?: string;
  argsRef?: string;
  outputRef?: string;
  latencyMs: number;
  tokensOutEst: number;
  status?: string;
}

export interface PromptSegmentRecord {
  llmCallId: string;
  ord: number;
  sourceKind: string;
  sourceName: string;
  charLen: number;
  tokenEst: number;
  sha256: string;
  isStatic: boolean;
  contributedBy?: string;
}

export interface ToolDefRecord {
  sessionId: string;
  name: string;
  kind: "builtin" | "mcp" | "skill" | "other";
  schemaJson: string;
  schemaTokensEst: number;
  sha256: string;
}

export interface BlobRecord {
  ref: string;
  mime: string;
  bytes: string;
}

export interface Insight {
  id: string;
  scopeType: "session" | "turn" | "harness";
  scopeId: string;
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

// SSE event shape for live tail
export interface LiveTailEvent {
  type: "session" | "turn" | "llm_call" | "tool_call" | "insight";
  data: SessionRecord | TurnRecord | LlmCallRecord | ToolCallRecord | Insight;
}
