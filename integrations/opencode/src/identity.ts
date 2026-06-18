/**
 * Tool/MCP/skill classification and provider mapping. See DESIGN.md §6.4/§6.5.
 *
 * Identity is *derived* — OpenCode has no boolean isMcp/isSkill flag:
 *   - built-in tools have fixed ids
 *   - MCP tools are namespaced "<server>_<tool>" (both halves sanitized)
 *   - skills use tool id "skill" with the real name in args.name
 */

export type ToolKind = "builtin" | "mcp" | "skill" | "other";

export interface ToolIdentity {
  kind: ToolKind;
  /** Human-facing span name. */
  displayName: string;
  /** OpenInference tag.tags values for slicing in Phoenix. */
  tags: string[];
  /** For MCP: the server key. For skills: the skill name. */
  scope?: string;
}

/**
 * Verified fixed set of OpenCode built-in tool ids (DESIGN.md §2). A drift test
 * guards this list.
 */
export const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "fetch",
  "todo",
  "search",
  "skill",
  "patch",
  "invalid",
  "question",
  "lsp",
  "plan",
]);

const MCP_NAME_RE = /^([a-zA-Z0-9-]+)_(.+)$/;

export interface ClassifyInput {
  tool: string;
  args?: unknown;
  metadata?: Record<string, unknown> | undefined;
  /** Known MCP server keys (sanitized) from config, if available. */
  mcpServers?: ReadonlySet<string>;
}

export function classifyTool(input: ClassifyInput): ToolIdentity {
  const { tool, args, metadata, mcpServers } = input;

  if (tool === "skill") {
    const name =
      (isRecord(args) && typeof args["name"] === "string" ? (args["name"] as string) : undefined) ??
      (metadata && typeof metadata["name"] === "string" ? (metadata["name"] as string) : undefined);
    const skillName = name ?? "unknown";
    return {
      kind: "skill",
      displayName: `skill:${skillName}`,
      tags: ["skill", `skill:${skillName}`],
      scope: skillName,
    };
  }

  if (BUILTIN_TOOLS.has(tool)) {
    return {
      kind: "builtin",
      displayName: tool,
      tags: ["tool", `tool:${tool}`],
    };
  }

  const m = MCP_NAME_RE.exec(tool);
  if (m) {
    const prefix = m[1]!;
    // If we have the configured server set, only treat as MCP when the prefix
    // matches a known server. Otherwise fall back to the split heuristic.
    if (!mcpServers || mcpServers.has(prefix)) {
      return {
        kind: "mcp",
        displayName: tool,
        tags: ["mcp", `mcp:${prefix}`],
        scope: prefix,
      };
    }
  }

  return {
    kind: "other",
    displayName: tool,
    tags: ["tool", `tool:${tool}`],
  };
}

/** OpenInference well-known provider values (LLMProvider enum). */
const PROVIDER_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  "anthropic-claude": "anthropic",
  claude: "anthropic",
  mistral: "mistralai",
  mistralai: "mistralai",
  cohere: "cohere",
  google: "google",
  "google-vertex": "google",
  "google-generative-ai": "google",
  gemini: "google",
  vertex: "google",
  aws: "aws",
  "amazon-bedrock": "aws",
  bedrock: "aws",
  azure: "azure",
  "azure-openai": "azure",
  xai: "xai",
  grok: "xai",
  deepseek: "deepseek",
  groq: "groq",
  fireworks: "fireworks",
  moonshot: "moonshot",
  cerebras: "cerebras",
  perplexity: "perplexity",
  together: "together",
  togetherai: "together",
};

/** Map provider → llm.system (a coarser enum). */
const SYSTEM_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  mistralai: "mistralai",
  cohere: "cohere",
  google: "vertexai",
  aws: "amazon",
  azure: "openai",
};

export interface ProviderIdentity {
  /** llm.provider value (well-known when mapped, else raw). */
  provider: string;
  /** llm.system value, omitted when unknown. */
  system?: string;
}

export function mapProvider(providerID: string): ProviderIdentity {
  const key = providerID.toLowerCase();
  const provider = PROVIDER_MAP[key] ?? providerID;
  const system = SYSTEM_MAP[provider];
  return system ? { provider, system } : { provider };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
