/**
 * Local type aliases for the OpenCode payload shapes this plugin touches.
 *
 * These are intentionally hand-written (a subset of `@opencode-ai/sdk` /
 * `@opencode-ai/plugin`) so the published package does not hard-depend on the
 * SDK at runtime and stays resilient to minor upstream churn. They were
 * verified against `@opencode-ai/plugin@1.17.4` / `@opencode-ai/sdk` types.
 */

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface UserMessage {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent: string;
  model: ModelRef;
  system?: string;
}

export interface MessageTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  cost: number;
  tokens: MessageTokens;
  finish?: string;
  error?: unknown;
}

export type Message = UserMessage | AssistantMessage;

export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface ToolPartStateCompleted {
  status: "completed";
  input?: unknown;
  output?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
}

export interface ToolPartStateError {
  status: "error";
  input?: unknown;
  error?: string;
  time?: { start: number; end?: number };
}

export interface ToolPartStateOther {
  status: "pending" | "running";
  input?: unknown;
}

export type ToolState =
  | ToolPartStateCompleted
  | ToolPartStateError
  | ToolPartStateOther;

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export interface ReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text?: string;
}

export interface FilePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime?: string;
  filename?: string;
  url?: string;
}

export type Part =
  | TextPart
  | ToolPart
  | ReasoningPart
  | FilePart
  | { id: string; type: string; [k: string]: unknown };

export interface ProviderContext {
  source: "env" | "config" | "custom" | "api";
  info: { id: string; name?: string };
  options: Record<string, unknown>;
}

/** Subset of the OpenCode plugin `client` we use. */
export interface OpencodeClientLike {
  app?: {
    log?: (input: {
      body: { service: string; level: string; message: string; extra?: Record<string, unknown> };
    }) => Promise<unknown>;
  };
  config?: {
    get?: () => Promise<{ data?: OpencodeConfig } | OpencodeConfig>;
  };
}

export interface OpencodeConfig {
  mcp?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Minimal Event shape; we only branch on `type`. */
export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown> & { info?: Message };
}
