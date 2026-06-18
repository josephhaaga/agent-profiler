/**
 * Small helpers for safely writing OpenInference attributes onto spans:
 * truncation, JSON stringification, and flattening primitives.
 */
import type { Span, AttributeValue } from "@opentelemetry/api";

const TRUNCATION_MARKER = "\u2026[truncated]";

/** Truncate a string to `max` chars, appending a marker when cut. */
export function truncate(value: string, max: number): string {
  if (max <= 0 || value.length <= max) return value;
  const head = Math.max(0, max - TRUNCATION_MARKER.length);
  return value.slice(0, head) + TRUNCATION_MARKER;
}

/** JSON.stringify that never throws (handles cycles / bigint). */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, jsonReplacer) ?? "";
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

function jsonReplacer(_key: string, val: unknown): unknown {
  if (typeof val === "bigint") return val.toString();
  return val;
}

/** Coerce arbitrary tool I/O into a string + best-guess mime type. */
export function toValueAndMime(value: unknown): { value: string; mime: "text/plain" | "application/json" } {
  if (typeof value === "string") {
    return { value, mime: looksLikeJson(value) ? "application/json" : "text/plain" };
  }
  if (value === null || value === undefined) return { value: "", mime: "text/plain" };
  return { value: safeJson(value), mime: "application/json" };
}

/** Cheap heuristic: does a string parse as a JSON object/array? */
function looksLikeJson(value: string): boolean {
  const t = value.trim();
  if (t.length < 2) return false;
  const first = t[0];
  const last = t[t.length - 1];
  const bracketed = (first === "{" && last === "}") || (first === "[" && last === "]");
  if (!bracketed) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set a string attribute, truncating to `maxAttrChars`. Skips empty values.
 */
export function setStr(
  span: Span,
  key: string,
  value: string | undefined | null,
  maxAttrChars: number,
): void {
  if (value === undefined || value === null || value === "") return;
  span.setAttribute(key, truncate(value, maxAttrChars));
}

/** Set a numeric attribute, skipping undefined/NaN. */
export function setNum(span: Span, key: string, value: number | undefined | null): void {
  if (value === undefined || value === null || !Number.isFinite(value)) return;
  span.setAttribute(key, value);
}

/** Set an attribute of any supported value type. */
export function setAttr(span: Span, key: string, value: AttributeValue | undefined): void {
  if (value === undefined) return;
  span.setAttribute(key, value);
}
