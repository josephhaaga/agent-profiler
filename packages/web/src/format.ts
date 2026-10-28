/** Display only recorded values. No inferred billing or missing-as-zero fallback. */
export function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return "Unknown";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "Unknown";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
export function fmtCost(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c) || c < 0) return "Unknown";
  if (c > 0 && c < 0.0001) return "<$0.0001";
  return c.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
export function fmtRatio(r: number | null): string {
  return r != null && Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : "Unknown";
}
export function ago(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
export function cacheRatio(s: { promptTokens: number | null; cacheReadTokens: number | null }): number {
  const { promptTokens: input, cacheReadTokens: cached } = s;
  return input != null && cached != null && Number.isFinite(input) && Number.isFinite(cached) && input > 0 && cached >= 0 && cached <= input
    ? cached / input : NaN;
}
