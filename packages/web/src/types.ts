export type HarnessKind = "opencode" | "vscode" | "custom";

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

export interface CompareResult {
  metrics: Array<{
    harness: string;
    sessionCount: number;
    meanCacheHitRatio: number;
    meanTokensPerTurn: number;
    meanCostPerTurn: number;
    meanLatencyMsPerTurn: number;
    meanTurnsPerSession: number;
  }>;
  pairwiseDeltas: Array<{
    from: string; to: string;
    cacheHitRatioDelta: { delta: number; ciLow: number; ciHigh: number };
    tokensPerTurnDelta: { delta: number; ciLow: number; ciHigh: number };
    costPerTurnDelta: { delta: number; ciLow: number; ciHigh: number };
  }>;
  insights: Insight[];
}
