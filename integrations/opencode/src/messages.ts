/**
 * Convert OpenCode message parts into OpenInference message objects.
 * See DESIGN.md §6.6.
 */
import type { Part, Message } from "./types.js";
import { safeJson, truncate } from "./attributes.js";

export interface OIToolCall {
  id?: string;
  name?: string;
  argumentsJson?: string;
}

export interface OIMessage {
  role: string;
  content?: string;
  toolCalls?: OIToolCall[];
}

export interface ConvertOptions {
  maxAttrChars: number;
  /** When false, file/large blobs are reduced to placeholders. */
  captureContent: boolean;
}

/**
 * Reduce a single message's parts to an OpenInference message. Text parts are
 * concatenated; tool-call parts become tool_calls; reasoning is omitted from
 * content (counted via reasoning tokens); files become short placeholders.
 */
export function partsToMessage(
  role: string,
  parts: Part[],
  opts: ConvertOptions,
): OIMessage {
  const textChunks: string[] = [];
  const toolCalls: OIToolCall[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text": {
        const t = (part as { text?: string }).text;
        if (typeof t === "string" && t.length > 0 && !(part as { synthetic?: boolean }).synthetic) {
          textChunks.push(t);
        }
        break;
      }
      case "tool": {
        const tp = part as {
          callID?: string;
          tool?: string;
          state?: { input?: unknown };
        };
        toolCalls.push({
          id: tp.callID,
          name: tp.tool,
          argumentsJson: tp.state?.input !== undefined ? safeJson(tp.state.input) : undefined,
        });
        break;
      }
      case "file": {
        const fp = part as { mime?: string; filename?: string };
        textChunks.push(`[file: ${fp.filename ?? "attachment"}${fp.mime ? ` (${fp.mime})` : ""}]`);
        break;
      }
      case "reasoning":
        // Omit from content; reasoning is captured via token counts.
        break;
      default:
        break;
    }
  }

  const msg: OIMessage = { role };
  if (textChunks.length > 0) {
    msg.content = truncate(textChunks.join("\n"), opts.maxAttrChars);
  }
  if (toolCalls.length > 0) msg.toolCalls = toolCalls;
  return msg;
}

/** Role string from an OpenCode message. */
export function messageRole(message: Message): string {
  return message.role;
}

/**
 * Build the full input message list from the transform payload
 * ({ info, parts }[]). Falls back gracefully on partial data.
 */
export function buildInputMessages(
  entries: { info: Message; parts: Part[] }[],
  opts: ConvertOptions,
): OIMessage[] {
  return entries.map((e) => partsToMessage(e.info.role, e.parts, opts));
}

/** Prepend system prompt strings as system messages. */
export function systemMessages(system: string[], opts: ConvertOptions): OIMessage[] {
  return system
    .filter((s) => typeof s === "string" && s.length > 0)
    .map((s) => ({ role: "system", content: truncate(s, opts.maxAttrChars) }));
}
