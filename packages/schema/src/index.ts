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
