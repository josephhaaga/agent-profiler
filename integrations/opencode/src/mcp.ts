/**
 * MCP key sanitization. OpenCode namespaces MCP tools as "<server>_<tool>"
 * where each half is sanitized via `value.replace(/[^a-zA-Z0-9_-]/g, "_")`
 * (verified, DESIGN.md §2). We sanitize configured server keys the same way so
 * the prefix match against tool ids is reliable.
 */
export function sanitizeMcpKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
