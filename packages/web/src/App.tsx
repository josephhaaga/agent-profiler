import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, ArrowLeft, ChevronRight, Command, GitCompare,
  Info, LayoutDashboard, Loader2, Radio, TriangleAlert, X,
} from "lucide-react";
import { api } from "./api";
import type {
  CompareResult, Insight, LlmCallRecord, PromptSegmentRecord,
  SessionRecord, ToolCallRecord, TurnRecord,
} from "./types";
import { useLiveTail } from "./useLiveTail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtCost(c: number): string {
  return c < 0.001 ? `$${(c * 1000).toFixed(3)}m` : `$${c.toFixed(4)}`;
}
function fmtRatio(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}
function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
function cacheRatio(s: { promptTokens: number; cacheReadTokens: number }): number {
  return s.promptTokens > 0 ? s.cacheReadTokens / s.promptTokens : 0;
}

// ── View types ────────────────────────────────────────────────────────────────

type View =
  | { page: "sessions" }
  | { page: "session"; id: string }
  | { page: "turn"; id: string; sessionId: string }
  | { page: "cache"; sessionId: string }
  | { page: "prompt"; llmCallId: string; sessionId: string }
  | { page: "compare" };

// ── Insight severity helpers ──────────────────────────────────────────────────

function InsightBadge({ severity }: { severity: Insight["severity"] }) {
  const variant =
    severity === "critical" ? "critical" : severity === "warn" ? "warn" : "info";
  const Icon = severity === "critical" ? TriangleAlert : severity === "warn" ? TriangleAlert : Info;
  return (
    <Badge variant={variant} className="gap-1">
      <Icon className="h-2.5 w-2.5" />
      {severity}
    </Badge>
  );
}

// Prominent insight card — Tufte: the insight IS the headline
function InsightCard({ insight }: { insight: Insight }) {
  const border =
    insight.severity === "critical"
      ? "border-red-500/30 bg-red-500/5"
      : insight.severity === "warn"
        ? "border-amber-500/25 bg-amber-500/5"
        : "border-border bg-card";
  return (
    <div className={cn("rounded-lg border px-4 py-3", border)}>
      <div className="flex items-start gap-3">
        <InsightBadge severity={insight.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground leading-snug">{insight.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{insight.summary}</p>
        </div>
        <code className="shrink-0 text-[10px] text-muted-foreground font-mono">{insight.kind}</code>
      </div>
    </div>
  );
}

// ── Metric row (replaces stat boxes) — Tufte: numbers on a baseline, no boxes ─

function MetricRow({
  metrics,
}: {
  metrics: Array<{ label: string; value: string; delta?: string; deltaDir?: "up" | "down" | "neutral"; highlight?: "ok" | "warn" }>;
}) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 py-3">
      {metrics.map((m) => (
        <div key={m.label} className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {m.label}
          </span>
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "text-base font-semibold tabular-nums",
                m.highlight === "ok" && "text-[hsl(var(--green))]",
                m.highlight === "warn" && "text-[hsl(var(--amber))]",
                !m.highlight && "text-foreground"
              )}
            >
              {m.value}
            </span>
            {m.delta && (
              <span
                className={cn(
                  "text-[10px] font-medium tabular-nums",
                  m.deltaDir === "up" && "text-[hsl(var(--green))]",
                  m.deltaDir === "down" && "text-[hsl(var(--red))]",
                  m.deltaDir === "neutral" && "text-muted-foreground"
                )}
              >
                {m.delta}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Sessions Explorer ─────────────────────────────────────────────────────────

function SessionsView({ onSelect }: { onSelect: (id: string) => void }) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<keyof SessionRecord>("startedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setLoading(true);
    api.sessions().then((d) => setSessions(d.sessions)).catch(console.error).finally(() => setLoading(false));
  }, []);

  const sorted = useMemo(() => {
    const filtered = filter
      ? sessions.filter(
          (s) =>
            s.id.includes(filter) ||
            s.agent?.toLowerCase().includes(filter.toLowerCase()) ||
            s.model?.toLowerCase().includes(filter.toLowerCase()) ||
            s.harness.includes(filter)
        )
      : sessions;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [sessions, filter, sortKey, sortDir]);

  function toggleSort(key: keyof SessionRecord) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortHead({ col, label }: { col: keyof SessionRecord; label: string }) {
    const active = sortKey === col;
    return (
      <TableHead
        className={cn("cursor-pointer select-none hover:text-foreground", active && "text-foreground")}
        onClick={() => toggleSort(col)}
      >
        {label}{active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
      </TableHead>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <Input
          className="w-64"
          placeholder="Filter by id, agent, model, harness…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead col="startedAt" label="Started" />
                <SortHead col="harness" label="Harness" />
                <SortHead col="agent" label="Agent" />
                <SortHead col="model" label="Model" />
                <SortHead col="turnCount" label="Turns" />
                <SortHead col="promptTokens" label="Prompt tok" />
                <SortHead col="cacheReadTokens" label="Cache hit" />
                <SortHead col="costTotal" label="Cost" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s) => {
                const hit = cacheRatio(s);
                return (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => onSelect(s.id)}
                  >
                    <TableCell className="text-muted-foreground">{ago(s.startedAt)}</TableCell>
                    <TableCell>
                      {/* Tufte: left-border color strip instead of full badge pill */}
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block w-0.5 h-4 rounded-full shrink-0"
                          style={{
                            background:
                              s.harness === "opencode" ? "hsl(var(--primary))"
                              : s.harness === "vscode" ? "hsl(var(--purple))"
                              : "hsl(var(--muted-foreground))",
                          }}
                        />
                        <span className="text-xs">{s.harness}</span>
                      </span>
                    </TableCell>
                    <TableCell>{s.agent ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{s.model ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{fmt(s.turnCount)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{fmt(s.promptTokens)}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "tabular-nums font-medium",
                        hit > 0.5 ? "text-[hsl(var(--green))]" : "text-[hsl(var(--amber))]"
                      )}>
                        {fmtRatio(hit)}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums font-medium">{fmtCost(s.costTotal)}</TableCell>
                  </TableRow>
                );
              })}
              {!sorted.length && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                    No sessions yet. Point your harness OTLP exporter at{" "}
                    <code className="text-xs bg-secondary px-1 py-0.5 rounded">
                      http://localhost:7070/v1/traces
                    </code>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Composite session timeline chart ─────────────────────────────────────────
// Tufte: one chart that answers "where did cost spike and why?"
// Bars = cost per turn; line = cache hit ratio; dots = tool call count

function SessionTimeline({
  turns,
  onTurnClick,
}: {
  turns: TurnRecord[];
  onTurnClick: (id: string) => void;
}) {
  if (!turns.length) return null;

  const BAR_H = 80;
  const LINE_H = 40;
  const TOTAL_H = BAR_H + LINE_H;
  const padL = 36, padR = 8, padTop = 8, labelH = 20;

  const maxCost = Math.max(...turns.map((t) => t.cost), 0.0001);
  const maxTools = Math.max(...turns.map((t) => t.llmRoundTrips), 1);
  const n = turns.length;

  // Colour thresholds
  function barColor(t: TurnRecord) {
    const ratio = t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0;
    if (ratio > 0.5) return "hsl(var(--green))";
    if (t.cost / maxCost > 0.6) return "hsl(var(--red))";
    return "hsl(var(--primary))";
  }

  const w = 100; // SVG user units per column (percent-like; viewBox sets scale)
  const totalW = n * w + padL + padR;
  const totalH = TOTAL_H + padTop + labelH;

  // Build cache-hit polyline points
  const polyline = turns
    .map((t, i) => {
      const cx = padL + i * w + w / 2;
      const ratio = t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0;
      const y = padTop + BAR_H + LINE_H * (1 - ratio);
      return `${cx},${y}`;
    })
    .join(" ");

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-[hsl(var(--primary))]" /> cost/turn
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t-2 border-[hsl(var(--amber))]" /> cache hit %
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${totalW} ${totalH}`}
          className="w-full"
          style={{ minWidth: Math.max(320, n * 28), height: totalH * 1.5 }}
        >
          {/* Y-axis gridlines (cost) */}
          {[0.25, 0.5, 0.75, 1].map((frac) => {
            const y = padTop + BAR_H * (1 - frac);
            return (
              <line
                key={frac}
                x1={padL}
                y1={y}
                x2={totalW - padR}
                y2={y}
                stroke="hsl(var(--border))"
                strokeWidth={0.5}
              />
            );
          })}

          {/* 50% cache hit reference line */}
          <line
            x1={padL}
            y1={padTop + BAR_H + LINE_H * 0.5}
            x2={totalW - padR}
            y2={padTop + BAR_H + LINE_H * 0.5}
            stroke="hsl(var(--amber))"
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={0.5}
          />
          <text
            x={padL - 2}
            y={padTop + BAR_H + LINE_H * 0.5 + 1}
            textAnchor="end"
            fontSize={6}
            fill="hsl(var(--amber))"
            opacity={0.7}
          >50%</text>

          {/* Bars */}
          {turns.map((t, i) => {
            const bh = Math.max(2, (t.cost / maxCost) * BAR_H);
            const x = padL + i * w + w * 0.15;
            const bw = w * 0.7;
            return (
              <rect
                key={t.id}
                x={x}
                y={padTop + BAR_H - bh}
                width={bw}
                height={bh}
                rx={2}
                fill={barColor(t)}
                opacity={0.85}
                className="cursor-pointer hover:opacity-100 transition-opacity"
                onClick={() => onTurnClick(t.id)}
              >
                <title>{`Turn ${t.idx + 1}: ${fmtCost(t.cost)}`}</title>
              </rect>
            );
          })}

          {/* Cache hit polyline */}
          <polyline
            points={polyline}
            fill="none"
            stroke="hsl(var(--amber))"
            strokeWidth={1.5}
            strokeLinejoin="round"
            opacity={0.9}
          />
          {turns.map((t, i) => {
            const ratio = t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0;
            const cx = padL + i * w + w / 2;
            const cy = padTop + BAR_H + LINE_H * (1 - ratio);
            return (
              <circle
                key={t.id}
                cx={cx}
                cy={cy}
                r={3}
                fill="hsl(var(--amber))"
                opacity={0.9}
                className="cursor-pointer"
                onClick={() => onTurnClick(t.id)}
              />
            );
          })}

          {/* Tool call dots (above bars) */}
          {turns.map((t, i) => {
            const cx = padL + i * w + w / 2;
            const r = 2 + (t.llmRoundTrips / maxTools) * 3;
            const bh = Math.max(2, (t.cost / maxCost) * BAR_H);
            const cy = padTop + BAR_H - bh - 4;
            if (t.llmRoundTrips === 0) return null;
            return (
              <circle
                key={t.id}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="hsl(var(--primary))"
                strokeWidth={1}
                opacity={0.6}
              />
            );
          })}

          {/* Turn labels */}
          {turns.map((t, i) => (
            <text
              key={t.id}
              x={padL + i * w + w / 2}
              y={totalH - 4}
              textAnchor="middle"
              fontSize={7}
              fill="hsl(var(--muted-foreground))"
            >
              {t.idx + 1}
            </text>
          ))}

          {/* Y-axis cost labels */}
          <text x={padL - 2} y={padTop + 4} textAnchor="end" fontSize={6} fill="hsl(var(--muted-foreground))">
            {fmtCost(maxCost)}
          </text>
          <text x={padL - 2} y={padTop + BAR_H} textAnchor="end" fontSize={6} fill="hsl(var(--muted-foreground))">
            $0
          </text>
        </svg>
      </div>
    </div>
  );
}

// ── Session Detail ────────────────────────────────────────────────────────────

function SessionDetailView({
  sessionId,
  onTurnSelect,
  onCacheView,
}: {
  sessionId: string;
  onTurnSelect: (turnId: string) => void;
  onCacheView: () => void;
}) {
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [profiling, setProfiling] = useState(false);

  useEffect(() => {
    api.session(sessionId).then((d) => setSession(d.session)).catch(console.error);
    api.turns(sessionId).then((d) => setTurns(d.turns)).catch(console.error);
    api.sessionInsights(sessionId).then((d) => setInsights(d.insights)).catch(console.error);
  }, [sessionId]);

  async function runProfile() {
    setProfiling(true);
    try {
      const d = await api.profile(sessionId);
      setInsights(d.insights);
    } finally {
      setProfiling(false);
    }
  }

  if (!session) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const hitRatio = cacheRatio(session);
  // Tufte: top insights sorted by severity so the headline is first
  const topInsights = [...insights].sort((a, b) => {
    const order = { critical: 0, warn: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  // Find peak cost turn for narrative headline
  const peakTurn = turns.length > 0 ? turns.reduce((a, b) => (b.cost > a.cost ? b : a)) : null;
  const peakFrac = peakTurn && session.costTotal > 0 ? peakTurn.cost / session.costTotal : 0;
  const lowestCacheTurn = turns.length > 0
    ? turns.reduce((a, b) => {
        const ra = a.promptTokens > 0 ? a.cacheReadTokens / a.promptTokens : 1;
        const rb = b.promptTokens > 0 ? b.cacheReadTokens / b.promptTokens : 1;
        return rb < ra ? b : a;
      })
    : null;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-0.5">
          <h1 className="text-lg font-semibold">Session</h1>
          <code className="text-[11px] text-muted-foreground font-mono">{session.id}</code>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCacheView}>Cache detail</Button>
          <Button variant="outline" size="sm" onClick={runProfile} disabled={profiling}>
            {profiling ? <><Loader2 className="h-3 w-3 animate-spin" /> Running…</> : "Run profilers"}
          </Button>
        </div>
      </div>

      {/* Tufte: headline narrative first, then supporting data */}
      {peakTurn && peakFrac > 0.25 && (
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground">
          Turn {peakTurn.idx + 1} consumed{" "}
          <span className="font-semibold text-[hsl(var(--amber))]">{fmtRatio(peakFrac)}</span> of session cost
          {lowestCacheTurn && lowestCacheTurn.id !== peakTurn.id && (
            <>
              {". "}Lowest cache efficiency at turn {lowestCacheTurn.idx + 1}{" "}
              <span className="font-semibold text-[hsl(var(--red))]">
                ({fmtRatio(lowestCacheTurn.promptTokens > 0 ? lowestCacheTurn.cacheReadTokens / lowestCacheTurn.promptTokens : 0)})
              </span>
            </>
          )}.
        </div>
      )}

      {/* Top-priority insights — before metrics, not after */}
      {topInsights.length > 0 && (
        <div className="space-y-2">
          {topInsights.slice(0, 3).map((ins) => (
            <InsightCard key={ins.id} insight={ins} />
          ))}
          {topInsights.length > 3 && (
            <p className="text-xs text-muted-foreground pl-1">
              +{topInsights.length - 3} more insights — run profilers to see all
            </p>
          )}
        </div>
      )}

      {/* Metric baseline — max 5, no boxes */}
      <Separator />
      <MetricRow
        metrics={[
          { label: "Cost", value: fmtCost(session.costTotal) },
          { label: "Cache hit", value: fmtRatio(hitRatio), highlight: hitRatio < 0.3 ? "warn" : "ok" },
          { label: "Prompt tok", value: fmt(session.promptTokens) },
          { label: "Turns", value: fmt(session.turnCount) },
          { label: "Tool calls", value: fmt(session.toolCallCount) },
        ]}
      />
      <Separator />

      {/* Composite timeline */}
      {turns.length > 1 && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Cost & cache per turn — click to drill in
          </h2>
          <SessionTimeline turns={turns} onTurnClick={onTurnSelect} />
        </div>
      )}

      {/* Slim turns table — 4 columns, not 8 */}
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Turns ({turns.length})
        </h2>
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>#</TableHead>
                <TableHead>User message</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Cache %</TableHead>
                <TableHead>Signal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {turns.map((t) => {
                const tr = t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0;
                return (
                  <TableRow key={t.id} className="cursor-pointer" onClick={() => onTurnSelect(t.id)}>
                    <TableCell className="text-muted-foreground tabular-nums">{t.idx + 1}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {t.userText?.slice(0, 80) ?? "—"}
                    </TableCell>
                    <TableCell className="tabular-nums font-medium">{fmtCost(t.cost)}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "tabular-nums",
                        tr > 0.5 ? "text-[hsl(var(--green))]" : "text-[hsl(var(--amber))]"
                      )}>
                        {fmtRatio(tr)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {t.endSignal === "error" ? (
                        <Badge variant="critical">error</Badge>
                      ) : t.endSignal === "user_stopped" ? (
                        <Badge variant="warn">stopped</Badge>
                      ) : (
                        <Badge variant="ok">ok</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

// ── Turn Detail / Waterfall ───────────────────────────────────────────────────
// Tufte: waterfall only — 2 colors (LLM=blue, tool=amber), no co-located tables.
// Click a bar to expand inline detail.

function TurnDetailView({
  turnId,
  sessionId,
  allTurns = [],
  onPromptView,
}: {
  turnId: string;
  sessionId: string;
  allTurns?: TurnRecord[];
  onPromptView: (llmCallId: string) => void;
}) {
  const [turn, setTurn] = useState<TurnRecord | null>(null);
  const [llmCalls, setLlmCalls] = useState<LlmCallRecord[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([]);
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
  const [blobCache, setBlobCache] = useState<Record<string, string>>({});

  useEffect(() => {
    api.turns(sessionId).then((d) => {
      const t = d.turns.find((x) => x.id === turnId);
      if (t) setTurn(t);
    });
    api.llmCalls(turnId).then((d) => setLlmCalls(d.llmCalls));
    api.toolCalls(turnId).then((d) => setToolCalls(d.toolCalls));
  }, [turnId, sessionId]);

  async function loadBlob(ref: string) {
    if (!blobCache[ref]) {
      const text = await api.blob(ref);
      setBlobCache((c) => ({ ...c, [ref]: text }));
    }
  }

  if (!turn) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  type SpanItem = { type: "llm" | "tool"; id: string; name: string; latencyMs: number; record: LlmCallRecord | ToolCallRecord };
  const spans: SpanItem[] = [
    ...llmCalls.map((c) => ({ type: "llm" as const, id: c.id, name: c.model, latencyMs: c.latencyMs, record: c })),
    ...toolCalls.map((c) => ({ type: "tool" as const, id: c.id, name: c.name, latencyMs: c.latencyMs, record: c })),
  ].sort((a, b) => b.latencyMs - a.latencyMs);

  const maxMs = spans.reduce((m, x) => Math.max(m, x.latencyMs), 1);

  function SpanDetail({ span }: { span: SpanItem }) {
    if (span.type === "llm") {
      const c = span.record as LlmCallRecord;
      return (
        <div className="space-y-3 pt-2">
          <MetricRow metrics={[
            { label: "Latency", value: fmtMs(c.latencyMs) },
            { label: "Prompt tok", value: fmt(c.promptTokens) },
            { label: "Completion tok", value: fmt(c.completionTokens) },
            { label: "Cache read", value: fmt(c.cacheReadTokens) },
            { label: "Cost", value: fmtCost(c.cost) },
          ]} />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onPromptView(c.id)}>
              Prompt inspector
            </Button>
            {c.inputMessagesRef && (
              <Button size="sm" variant="ghost" onClick={() => { void loadBlob(c.inputMessagesRef!); }}>
                {blobCache[c.inputMessagesRef] ? "Hide messages" : "Show messages"}
              </Button>
            )}
          </div>
          {c.inputMessagesRef && blobCache[c.inputMessagesRef] && (
            <pre className="body-pre">{blobCache[c.inputMessagesRef]}</pre>
          )}
        </div>
      );
    }
    const tc = span.record as ToolCallRecord;
    return (
      <div className="space-y-3 pt-2">
        <MetricRow metrics={[
          { label: "Kind", value: tc.kind },
          { label: "Latency", value: fmtMs(tc.latencyMs) },
          { label: "Output tok est", value: fmt(tc.tokensOutEst) },
          { label: "Status", value: tc.status ?? "—" },
          ...(tc.server ? [{ label: "Server", value: tc.server }] : []),
        ]} />
        <div className="flex gap-2">
          {tc.argsRef && (
            <Button size="sm" variant="ghost" onClick={() => { void loadBlob(tc.argsRef!); }}>
              {blobCache[tc.argsRef!] ? "Hide args" : "Show args"}
            </Button>
          )}
          {tc.outputRef && (
            <Button size="sm" variant="ghost" onClick={() => { void loadBlob(tc.outputRef!); }}>
              {blobCache[tc.outputRef!] ? "Hide output" : "Show output"}
            </Button>
          )}
        </div>
        {tc.argsRef && blobCache[tc.argsRef] && <pre className="body-pre">{blobCache[tc.argsRef]}</pre>}
        {tc.outputRef && blobCache[tc.outputRef] && <pre className="body-pre">{blobCache[tc.outputRef]}</pre>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h1 className="text-lg font-semibold">Turn {turn.idx + 1}</h1>
          <code className="text-[11px] text-muted-foreground font-mono">{turn.id}</code>
        </div>
        {allTurns.length > 1 && (
          <div className="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
            <span>{turn.idx + 1} / {allTurns.length}</span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-secondary px-1 py-0.5 font-mono text-[10px]">k</kbd>
              <span>prev</span>
              <kbd className="rounded border border-border bg-secondary px-1 py-0.5 font-mono text-[10px]">j</kbd>
              <span>next</span>
            </span>
          </div>
        )}
      </div>

      <MetricRow metrics={[
        { label: "Cost", value: fmtCost(turn.cost) },
        { label: "Cache hit", value: fmtRatio(turn.promptTokens > 0 ? turn.cacheReadTokens / turn.promptTokens : 0) },
        { label: "LLM calls", value: fmt(turn.llmRoundTrips) },
        { label: "Prompt tok", value: fmt(turn.promptTokens) },
        { label: "Completion tok", value: fmt(turn.completionTokens) },
      ]} />
      <Separator />

      {turn.userText && (
        <div className="space-y-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">User</h2>
          <pre className="body-pre">{turn.userText}</pre>
        </div>
      )}

      {turn.assistantText && (
        <div className="space-y-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Assistant</h2>
          <pre className="body-pre">
            {turn.assistantText.slice(0, 2000)}
            {turn.assistantText.length > 2000 ? "\n…(truncated)" : ""}
          </pre>
        </div>
      )}

      {/* Waterfall — Tufte: 2 colors, no co-located tables */}
      {spans.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Span waterfall — click to expand
            </h2>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-[hsl(var(--primary))]" /> LLM
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-[hsl(var(--amber))]" /> Tool
              </span>
            </div>
          </div>
          <div className="space-y-1">
            {spans.map((span) => {
              const pct = Math.max(2, (span.latencyMs / maxMs) * 100);
              const isSelected = selectedSpan === span.id;
              return (
                <div key={span.id} className="rounded-md overflow-hidden border border-transparent hover:border-border transition-colors">
                  <div
                    className="flex items-center gap-3 h-8 px-2 cursor-pointer"
                    onClick={() => setSelectedSpan(isSelected ? null : span.id)}
                  >
                    <span className="w-40 shrink-0 text-[11px] text-muted-foreground truncate" title={span.name}>
                      {span.name}
                    </span>
                    <div className="flex-1 h-3.5 bg-secondary rounded-sm overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-sm transition-all",
                          span.type === "llm" ? "waterfall-bar-llm" : "waterfall-bar-tool"
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-14 text-right text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {fmtMs(span.latencyMs)}
                    </span>
                    <ChevronRight className={cn("h-3 w-3 text-muted-foreground shrink-0 transition-transform", isSelected && "rotate-90")} />
                  </div>
                  {isSelected && (
                    <div className="px-3 pb-3 bg-card border-t border-border">
                      <SpanDetail span={span} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cache Panel — 100% normalized bars + aggregate reference line ─────────────

function CachePanelView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [session, setSession] = useState<SessionRecord | null>(null);

  useEffect(() => {
    api.session(sessionId).then((d) => setSession(d.session));
    api.turns(sessionId).then((d) => setTurns(d.turns));
  }, [sessionId]);

  if (!session) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const sessionHitRatio = cacheRatio(session);
  const turnSeries = turns.map((t) => ({
    idx: t.idx + 1,
    id: t.id,
    ratio: t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0,
    prompt: t.promptTokens,
  }));

  const CHART_H = 120;
  const padL = 28, padR = 8, padTop = 8, labelH = 16;
  const n = turnSeries.length || 1;
  const colW = 40;
  const totalW = n * colW + padL + padR;
  const totalH = CHART_H + padTop + labelH;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Cache Detail</h1>

      <MetricRow metrics={[
        { label: "Overall hit ratio", value: fmtRatio(sessionHitRatio), highlight: sessionHitRatio > 0.5 ? "ok" : "warn" },
        { label: "Cache-read tok", value: fmt(session.cacheReadTokens) },
        { label: "Cache-write tok", value: fmt(session.cacheWriteTokens) },
      ]} />
      <Separator />

      {/* 100% normalized bars — Tufte: each bar same height, fraction is the signal */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Cache hit fraction per turn (normalized)
          </h2>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm bg-[hsl(var(--green))]" /> cache read
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm bg-secondary" /> prompt total
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${totalW} ${totalH}`}
            className="w-full"
            style={{ minWidth: Math.max(200, n * 30), height: totalH * 1.5 }}
          >
            {/* Gridlines at 25%, 50%, 75% */}
            {[0.25, 0.5, 0.75].map((frac) => {
              const y = padTop + CHART_H * (1 - frac);
              return (
                <g key={frac}>
                  <line x1={padL} y1={y} x2={totalW - padR} y2={y} stroke="hsl(var(--border))" strokeWidth={0.5} />
                  <text x={padL - 2} y={y + 2} textAnchor="end" fontSize={6} fill="hsl(var(--muted-foreground))">
                    {Math.round(frac * 100)}%
                  </text>
                </g>
              );
            })}

            {/* Session-average reference line */}
            <line
              x1={padL}
              y1={padTop + CHART_H * (1 - sessionHitRatio)}
              x2={totalW - padR}
              y2={padTop + CHART_H * (1 - sessionHitRatio)}
              stroke="hsl(var(--amber))"
              strokeWidth={1}
              strokeDasharray="4 2"
            />
            <text
              x={totalW - padR}
              y={padTop + CHART_H * (1 - sessionHitRatio) - 2}
              textAnchor="end"
              fontSize={6}
              fill="hsl(var(--amber))"
            >
              avg {fmtRatio(sessionHitRatio)}
            </text>

            {/* Normalized bars */}
            {turnSeries.map((t, i) => {
              const x = padL + i * colW + colW * 0.15;
              const bw = colW * 0.7;
              const fullH = CHART_H;
              const hitH = fullH * t.ratio;
              return (
                <g key={t.id}>
                  {/* Full bar (prompt total) */}
                  <rect x={x} y={padTop} width={bw} height={fullH} rx={2} fill="hsl(var(--secondary))" />
                  {/* Cache read portion */}
                  <rect
                    x={x}
                    y={padTop + fullH - hitH}
                    width={bw}
                    height={Math.max(hitH, 1)}
                    rx={2}
                    fill="hsl(var(--green))"
                    opacity={0.85}
                  />
                  {/* Turn label */}
                  <text x={x + bw / 2} y={totalH - 2} textAnchor="middle" fontSize={7} fill="hsl(var(--muted-foreground))">
                    {t.idx}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

// ── Prompt Inspector — treemap strip only (no redundant table) ────────────────

const SEG_COLORS: Record<string, string> = {
  system: "hsl(var(--primary))",
  tool: "hsl(var(--amber))",
  mcp: "hsl(var(--purple))",
  skill: "hsl(var(--green))",
  user: "hsl(var(--muted-foreground))",
  assistant: "hsl(258 90% 60%)",
  instructions: "hsl(var(--primary))",
};
function segColor(k: string) { return SEG_COLORS[k] ?? "hsl(var(--muted-foreground))"; }

function PromptInspectorView({ llmCallId, sessionId }: { llmCallId: string; sessionId: string }) {
  const [segments, setSegments] = useState<PromptSegmentRecord[]>([]);
  const [messages, setMessages] = useState<string | null>(null);
  const [llmCall, setLlmCall] = useState<LlmCallRecord | null>(null);
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null);

  useEffect(() => {
    api.segments(llmCallId).then((d) => setSegments(d.segments));
    api.llmCalls(sessionId).then((d) => {
      const c = d.llmCalls.find((x) => x.id === llmCallId);
      if (c) {
        setLlmCall(c);
        if (c.inputMessagesRef) api.blob(c.inputMessagesRef).then(setMessages);
      }
    });
  }, [llmCallId, sessionId]);

  const totalChars = segments.reduce((s, x) => s + x.charLen, 0);
  const totalTokens = segments.reduce((s, x) => s + x.tokenEst, 0);

  if (!llmCall) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-0.5">
        <h1 className="text-lg font-semibold">Prompt Inspector</h1>
        <code className="text-[11px] text-muted-foreground font-mono">{llmCallId}</code>
      </div>

      <MetricRow metrics={[
        { label: "Model", value: llmCall.model },
        { label: "Prompt tok", value: fmt(llmCall.promptTokens) },
        { label: "Cache read", value: fmt(llmCall.cacheReadTokens) },
        { label: "Segments", value: fmt(segments.length) },
        { label: "Est. segment tok", value: fmt(totalTokens) },
      ]} />
      <Separator />

      {segments.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Prompt composition — click a segment
          </h2>

          {/* Treemap strip */}
          <div className="flex h-7 rounded-md overflow-hidden border border-border gap-px">
            {segments.map((seg, i) => {
              const pct = totalChars > 0 ? Math.max(0.5, (seg.charLen / totalChars) * 100) : 0;
              return (
                <TooltipProvider key={i}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "h-full cursor-pointer transition-opacity hover:opacity-75",
                          selectedSeg === i && "ring-2 ring-ring ring-inset"
                        )}
                        style={{ width: `${pct}%`, background: segColor(seg.sourceKind) }}
                        onClick={() => setSelectedSeg(selectedSeg === i ? null : i)}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{seg.sourceName}</p>
                      <p className="text-muted-foreground">{seg.sourceKind} · ~{fmt(seg.tokenEst)} tok · {fmt(seg.charLen)} chars</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {segments.map((seg, i) => (
              <button
                key={i}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setSelectedSeg(selectedSeg === i ? null : i)}
              >
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: segColor(seg.sourceKind) }} />
                {seg.sourceName}
                <span className="text-[10px]">~{fmt(seg.tokenEst)}t</span>
                {!seg.isStatic && <Badge variant="warn" className="text-[9px] px-1">volatile</Badge>}
              </button>
            ))}
          </div>

          {/* Selected segment detail — replaces always-on table */}
          {selectedSeg !== null && segments[selectedSeg] && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: segColor(segments[selectedSeg].sourceKind) }} />
                  {segments[selectedSeg].sourceName}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <MetricRow metrics={[
                  { label: "Kind", value: segments[selectedSeg].sourceKind },
                  { label: "Characters", value: fmt(segments[selectedSeg].charLen) },
                  { label: "Est. tokens", value: fmt(segments[selectedSeg].tokenEst) },
                  { label: "Static", value: segments[selectedSeg].isStatic ? "yes" : "no" },
                ]} />
                <p className="mt-2 text-[11px] text-muted-foreground font-mono">
                  SHA256: {segments[selectedSeg].sha256.slice(0, 20)}…
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      ) : messages ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No segment data — enriched capture (§4.1) not active. Raw messages:
          </p>
          <pre className="body-pre">{messages.slice(0, 4000)}</pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No prompt data for this LLM call.</p>
      )}
    </div>
  );
}

// ── Compare — deltas ranked by magnitude, not flat grid ───────────────────────

function CompareView() {
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.compare().then((d) => setResult(d.compare)).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!result?.metrics.length) {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Cross-Harness Compare</h1>
        <p className="text-sm text-muted-foreground">
          No data. Ingest traces from multiple harnesses first.
        </p>
      </div>
    );
  }

  // Sort insights by severity; sort pairwise deltas by absolute cost delta magnitude
  const topInsights = [...result.insights].sort((a, b) => {
    const order = { critical: 0, warn: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
  const sortedDeltas = [...result.pairwiseDeltas].sort(
    (a, b) => Math.abs(b.costPerTurnDelta.delta) - Math.abs(a.costPerTurnDelta.delta)
  );

  function DeltaRow({
    label,
    delta,
    ciLow,
    ciHigh,
    format,
    lowerIsBetter,
  }: {
    label: string;
    delta: number;
    ciLow: number;
    ciHigh: number;
    format: (v: number) => string;
    lowerIsBetter: boolean;
  }) {
    const isImprovement = lowerIsBetter ? delta < 0 : delta > 0;
    const colorClass = isImprovement
      ? "text-[hsl(var(--green))]"
      : delta === 0 ? "text-muted-foreground"
      : "text-[hsl(var(--amber))]";
    return (
      <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="text-right">
          <span className={cn("text-sm font-semibold tabular-nums", colorClass)}>
            {delta >= 0 ? "+" : ""}{format(delta)}
          </span>
          <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
            95% CI [{format(ciLow)}, {format(ciHigh)}]
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Cross-Harness Compare</h1>

      {topInsights.length > 0 && (
        <div className="space-y-2">
          {topInsights.map((ins) => <InsightCard key={ins.id} insight={ins} />)}
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Per-harness metrics
        </h2>
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Harness</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Cache hit %</TableHead>
                <TableHead>Tokens/turn</TableHead>
                <TableHead>Cost/turn</TableHead>
                <TableHead>Latency/turn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.metrics.map((m) => (
                <TableRow key={m.harness}>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-0.5 h-4 rounded-full shrink-0"
                        style={{
                          background:
                            m.harness === "opencode" ? "hsl(var(--primary))"
                            : m.harness === "vscode" ? "hsl(var(--purple))"
                            : "hsl(var(--muted-foreground))",
                        }}
                      />
                      {m.harness}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">{fmt(m.sessionCount)}</TableCell>
                  <TableCell>
                    <span className={cn(
                      "tabular-nums",
                      m.meanCacheHitRatio > 0.5 ? "text-[hsl(var(--green))]" : "text-[hsl(var(--amber))]"
                    )}>
                      {fmtRatio(m.meanCacheHitRatio)}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{fmt(m.meanTokensPerTurn, 0)}</TableCell>
                  <TableCell className="tabular-nums font-medium">{fmtCost(m.meanCostPerTurn)}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{fmtMs(m.meanLatencyMsPerTurn)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Sorted pairwise deltas — biggest impact first */}
      {sortedDeltas.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pairwise deltas — ranked by cost impact
          </h2>
          {sortedDeltas.map((d) => (
            <Card key={`${d.from}-${d.to}`}>
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="text-foreground">{d.from}</span>
                  <span>vs</span>
                  <span className="text-foreground">{d.to}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <DeltaRow
                  label="Cost / turn"
                  delta={d.costPerTurnDelta.delta}
                  ciLow={d.costPerTurnDelta.ciLow}
                  ciHigh={d.costPerTurnDelta.ciHigh}
                  format={fmtCost}
                  lowerIsBetter
                />
                <DeltaRow
                  label="Tokens / turn"
                  delta={d.tokensPerTurnDelta.delta}
                  ciLow={d.tokensPerTurnDelta.ciLow}
                  ciHigh={d.tokensPerTurnDelta.ciHigh}
                  format={(v) => fmt(v, 0)}
                  lowerIsBetter
                />
                <DeltaRow
                  label="Cache hit %"
                  delta={d.cacheHitRatioDelta.delta}
                  ciLow={d.cacheHitRatioDelta.ciLow}
                  ciHigh={d.cacheHitRatioDelta.ciHigh}
                  format={fmtRatio}
                  lowerIsBetter={false}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Live Tail — explicit mode, not persistent sidebar ─────────────────────────

function LiveTailView({ onClose }: { onClose: () => void }) {
  const events = useLiveTail(true);
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[hsl(var(--green))] live-pulse" />
          Live tail
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-4 py-2 space-y-1">
          {events.length === 0 && (
            <p className="text-xs text-muted-foreground py-4">Waiting for events…</p>
          )}
          {events.map((e, i) => (
            <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0">
              <Badge variant="neutral" className="text-[10px] shrink-0">{e.type}</Badge>
              <code className="text-[10px] text-muted-foreground truncate">
                {(e.data as Record<string, unknown>).id
                  ? String((e.data as Record<string, unknown>).id).slice(0, 24)
                  : "—"}
              </code>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Omnibar ───────────────────────────────────────────────────────────────────

const STATIC_COMMANDS = [
  { label: "Sessions", action: "sessions", icon: LayoutDashboard },
  { label: "Cross-Harness Compare", action: "compare", icon: GitCompare },
  { label: "Live tail", action: "live-tail", icon: Radio },
];

function Omnibar({
  open,
  onClose,
  onNavigate,
  sessions,
  onLiveTail,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: View) => void;
  sessions: SessionRecord[];
  onLiveTail: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const cmds = STATIC_COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
    const sess = sessions
      .filter((s) =>
        s.id.toLowerCase().includes(q) ||
        (s.agent ?? "").toLowerCase().includes(q) ||
        (s.model ?? "").toLowerCase().includes(q)
      )
      .slice(0, 8)
      .map((s) => ({
        label: `${s.agent ?? s.id.slice(0, 8)} — ${s.model ?? "?"}`,
        sublabel: ago(s.startedAt),
        action: `session:${s.id}`,
        icon: LayoutDashboard,
      }));
    return [
      ...cmds.map((c) => ({ ...c, sublabel: "command", icon: c.icon })),
      ...sess,
    ];
  }, [query, sessions]);

  function select(action: string) {
    if (action === "sessions") onNavigate({ page: "sessions" });
    else if (action === "compare") onNavigate({ page: "compare" });
    else if (action === "live-tail") onLiveTail();
    else if (action.startsWith("session:")) onNavigate({ page: "session", id: action.slice(8) });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="p-0 gap-0 overflow-hidden max-w-xl">
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Command className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 py-4 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            placeholder="Search sessions, go to view…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && items[0]) select(items[0].action);
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">No results</p>
          )}
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.action}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent transition-colors text-sm"
                onClick={() => select(item.action)}
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-foreground">{item.label}</span>
                  {item.sublabel && (
                    <span className="ml-2 text-xs text-muted-foreground">{item.sublabel}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function Breadcrumb({
  view,
  history,
  onNavigate,
}: {
  view: View;
  history: View[];
  onNavigate: (v: View) => void;
}) {
  const crumbs: { label: string; view: View }[] = [
    { label: "Sessions", view: { page: "sessions" } },
  ];
  if (view.page === "session") crumbs.push({ label: view.id.slice(0, 10) + "…", view });
  if (view.page === "turn") {
    const prev = history.find((h) => h.page === "session") as ({ page: "session"; id: string } | undefined);
    if (prev) crumbs.push({ label: "Session", view: prev });
    crumbs.push({ label: `Turn ${view.id.slice(0, 6)}`, view });
  }
  if (view.page === "cache") crumbs.push({ label: "Cache detail", view });
  if (view.page === "prompt") crumbs.push({ label: "Prompt Inspector", view });
  if (view.page === "compare") crumbs.push({ label: "Compare", view });

  return (
    <nav className="flex items-center gap-1 mb-5 text-xs text-muted-foreground">
      {crumbs.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
          <span
            className={cn(
              i === crumbs.length - 1
                ? "text-foreground"
                : "cursor-pointer hover:text-foreground transition-colors"
            )}
            onClick={() => i < crumbs.length - 1 && onNavigate(c.view)}
          >
            {c.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

// ── Hash routing ─────────────────────────────────────────────────────────────

function viewToHash(v: View): string {
  switch (v.page) {
    case "sessions": return "#/sessions";
    case "session":  return `#/sessions/${v.id}`;
    case "turn":     return `#/sessions/${v.sessionId}/turns/${v.id}`;
    case "cache":    return `#/sessions/${v.sessionId}/cache`;
    case "prompt":   return `#/sessions/${v.sessionId}/prompt/${v.llmCallId}`;
    case "compare":  return "#/compare";
  }
}

function hashToView(hash: string): View {
  const h = hash.replace(/^#/, "");
  const m = (pattern: RegExp) => h.match(pattern);
  let match: RegExpMatchArray | null;
  if ((match = m(/^\/sessions\/([^/]+)\/turns\/([^/]+)$/)))
    return { page: "turn", sessionId: match[1], id: match[2] };
  if ((match = m(/^\/sessions\/([^/]+)\/cache$/)))
    return { page: "cache", sessionId: match[1] };
  if ((match = m(/^\/sessions\/([^/]+)\/prompt\/([^/]+)$/)))
    return { page: "prompt", sessionId: match[1], llmCallId: match[2] };
  if ((match = m(/^\/sessions\/([^/]+)$/)))
    return { page: "session", id: match[1] };
  if (h === "/compare")
    return { page: "compare" };
  return { page: "sessions" };
}

// ── App shell ─────────────────────────────────────────────────────────────────

export function App() {
  const [view, setView] = useState<View>(() => hashToView(window.location.hash));
  const [history, setHistory] = useState<View[]>([]);
  const [omnibarOpen, setOmnibarOpen] = useState(false);
  const [liveTailOpen, setLiveTailOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  // Ordered turn list kept warm for j/k navigation — populated whenever we're
  // anywhere inside a session (turn, cache, prompt pages).
  const [sessionTurns, setSessionTurns] = useState<TurnRecord[]>([]);
  // Stable refs so the keydown listener (registered once) reads fresh values.
  const viewRef = useRef<View>({ page: "sessions" });
  const sessionTurnsRef = useRef<TurnRecord[]>([]);
  const navigateRef = useRef<(v: View) => void>(() => {});

  // Sync URL → view on browser back/forward
  useEffect(() => {
    const onPop = () => setView(hashToView(window.location.hash));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    api.sessions().then((d) => setSessions(d.sessions)).catch(console.error);
  }, []);

  // Keep sessionTurns warm whenever we land on any session-scoped page
  useEffect(() => {
    const sid =
      view.page === "turn"    ? view.sessionId :
      view.page === "session" ? view.id :
      view.page === "cache"   ? view.sessionId :
      view.page === "prompt"  ? view.sessionId : null;
    if (sid) {
      api.turns(sid)
        .then((d) => {
          setSessionTurns(d.turns);
          sessionTurnsRef.current = d.turns;
        })
        .catch(console.error);
    }
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in an input or the omnibar
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOmnibarOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") { setOmnibarOpen(false); return; }

      // j = next turn  /  k = prev turn
      if (e.key === "j" || e.key === "k") {
        const current = viewRef.current;
        if (current.page !== "turn") return;
        const turns = sessionTurnsRef.current;
        const idx = turns.findIndex((t) => t.id === current.id);
        if (idx === -1) return;
        const nextIdx = e.key === "j" ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= turns.length) return;
        const nextTurn = turns[nextIdx];
        navigateRef.current({ page: "turn", id: nextTurn.id, sessionId: current.sessionId });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function navigate(next: View) {
    setHistory((h) => [...h, view]);
    window.history.pushState(null, "", viewToHash(next));
    setView(next);
    if (next.page === "sessions") {
      api.sessions().then((d) => setSessions(d.sessions)).catch(console.error);
    }
  }

  // Keep ref in sync so the keydown closure (registered once) can call navigate
  navigateRef.current = navigate;

  const navItems = [
    { page: "sessions" as const, label: "Sessions", icon: LayoutDashboard },
    { page: "compare" as const, label: "Compare", icon: GitCompare },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Topbar */}
      <header className="sticky top-0 z-10 flex h-11 items-center justify-between border-b border-border bg-card/80 backdrop-blur-sm px-4">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <span className="text-[11px] font-bold tracking-widest uppercase text-primary">
              agent-profiler
            </span>
          </span>
          <Separator orientation="vertical" className="h-4" />
          <nav className="flex gap-0.5">
            {navItems.map(({ page, label, icon: Icon }) => (
              <button
                key={page}
                onClick={() => navigate({ page })}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                  view.page === page
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLiveTailOpen((v) => !v)}
            className={cn(
              "gap-1.5 text-xs",
              liveTailOpen && "text-[hsl(var(--green))] border-[hsl(var(--green))]/30 border"
            )}
          >
            <Radio className={cn("h-3.5 w-3.5", liveTailOpen && "live-pulse")} />
            {liveTailOpen ? "Live" : "Live tail"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOmnibarOpen(true)} className="gap-1.5 text-xs text-muted-foreground">
            <Command className="h-3.5 w-3.5" />K
          </Button>
        </div>
      </header>

      {/* Main layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Content */}
        <main className="flex-1 overflow-y-auto px-6 py-5">
          <Breadcrumb view={view} history={history} onNavigate={navigate} />

          {view.page === "sessions" && (
            <SessionsView onSelect={(id) => navigate({ page: "session", id })} />
          )}
          {view.page === "session" && (
            <SessionDetailView
              sessionId={view.id}
              onTurnSelect={(id) => navigate({ page: "turn", id, sessionId: view.id })}
              onCacheView={() => navigate({ page: "cache", sessionId: view.id })}
            />
          )}
          {view.page === "turn" && (
            <TurnDetailView
              turnId={view.id}
              sessionId={view.sessionId}
              allTurns={sessionTurns}
              onPromptView={(llmCallId) =>
                navigate({ page: "prompt", llmCallId, sessionId: view.sessionId })
              }
            />
          )}
          {view.page === "cache" && <CachePanelView sessionId={view.sessionId} />}
          {view.page === "prompt" && (
            <PromptInspectorView llmCallId={view.llmCallId} sessionId={view.sessionId} />
          )}
          {view.page === "compare" && <CompareView />}
        </main>

        {/* Live tail — separate panel, not persistent sidebar */}
        {liveTailOpen && (
          <aside className="w-64 border-l border-border bg-card flex flex-col shrink-0">
            <LiveTailView onClose={() => setLiveTailOpen(false)} />
          </aside>
        )}
      </div>

      <Omnibar
        open={omnibarOpen}
        onClose={() => setOmnibarOpen(false)}
        onNavigate={navigate}
        sessions={sessions}
        onLiveTail={() => setLiveTailOpen((v) => !v)}
      />
    </div>
  );
}
