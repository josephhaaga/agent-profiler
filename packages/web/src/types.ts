export type HarnessKind = "opencode" | "vscode" | "custom";

interface CaptureRecord {
  capture?: { source: string; partial?: boolean; unknownMetrics?: string[] };
}
interface UsageRecord extends CaptureRecord {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

export interface SessionRecord extends UsageRecord {
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
  costTotal: number | null;
  endReason?: string;
}

export interface TurnRecord extends UsageRecord {
  id: string;
  sessionId: string;
  idx: number;
  userText?: string;
  assistantText?: string;
  startedAt: string;
  endedAt?: string;
  llmRoundTrips: number;
  cost: number | null;
  status?: string;
  endSignal?: "completed" | "user_stopped" | "error";
}

export interface LlmCallRecord extends UsageRecord {
  id: string;
  turnId: string;
  sessionId: string;
  model: string;
  provider?: string;
  paramsJson?: string;
  cost: number | null;
  latencyMs: number | null;
  finishReason?: string;
  inputMessagesRef?: string;
  outputRef?: string;
}

export interface ToolCallRecord extends CaptureRecord {
  id: string;
  turnId: string;
  sessionId: string;
  name: string;
  kind: "builtin" | "mcp" | "skill" | "other";
  server?: string;
  skill?: string;
  argsRef?: string;
  outputRef?: string;
  latencyMs: number | null;
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
