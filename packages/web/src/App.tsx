import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronRight, Command, GitCompare, Circle, CircleAlert, Search,
  Info, LayoutDashboard, Loader2, Radio, X, Menu, Keyboard, SlidersHorizontal, Layers, RefreshCw,
} from "lucide-react";
import { api } from "./api";
import type {
  Insight, LlmCallRecord,
  SessionRecord, ToolCallRecord, TurnRecord,
} from "./types";
import { useLiveTail } from "./useLiveTail";
import { LiveActivity } from "./LiveActivity";
import { AnimalBackground } from "./AnimalBackground";
import { useResource } from "./useResource";
import { ago, cacheRatio, fmt, fmtCost, fmtMs, fmtRatio } from "./format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── View types ────────────────────────────────────────────────────────────────

type View =
  | { page: "sessions" }
  | { page: "session"; id: string }
  | { page: "turn"; id: string; sessionId: string }
  | { page: "cache"; sessionId: string }
  | { page: "prompt"; llmCallId: string; sessionId: string }
  | { page: "compare" };

// ── Insight severity helpers ──────────────────────────────────────────────────

function ReadError({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><p>Cannot refresh this view. Last loaded values, if any, may be stale. <span className="text-secondary-foreground">{error}</span></p><Button onClick={onRetry}>Retry read</Button></div> : null;
}

// Prominent insight card — Tufte: the insight IS the headline
function InsightCard({ insight, onInspect }: { insight: Insight; onInspect?: () => void }) {
  return (
    <article className="finding-row">
      <div>
        {insight.severity === "info" ? <Info className="mt-0.5 h-4 w-4 text-muted-foreground" aria-label="Observation" /> : <CircleAlert className="mt-0.5 h-4 w-4 text-amber" aria-label="Recorded issue" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground leading-snug">{insight.title}</p>
          <p className="mt-1.5 max-w-[72ch] text-[13px] leading-relaxed text-secondary-foreground">{insight.summary}</p>
          <details className="mt-2 text-xs"><summary className="cursor-pointer text-primary">Inspect evidence</summary>
            <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
              {Object.entries(insight.evidence).map(([key, value]) => <div key={key} className="contents"><dt className="break-words text-secondary-foreground">{key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt><dd className="break-words tabular-nums">{value == null ? "Unknown" : typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}
            </dl>
            {onInspect && <Button className="mt-2" size="sm" onClick={onInspect}>Open recorded context</Button>}
          </details>
        </div>
      </div>
    </article>
  );
}

// ── Metric row (replaces stat boxes) — Tufte: numbers on a baseline, no boxes ─

function MetricRow({
  metrics,
}: {
  metrics: Array<{ label: string; value: string; delta?: string; deltaDir?: "up" | "down" | "neutral"; highlight?: "ok" | "warn" }>;
}) {
  return (
    <div className="metric-baseline">
      {metrics.map((m) => (
        <div key={m.label} className="flex flex-col gap-0.5">
          <span className="metric-label">
            {m.label}
          </span>
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "metric-value",
                m.highlight === "ok" && "text-green",
                m.highlight === "warn" && "text-amber",
                !m.highlight && "text-foreground"
              )}
            >
              {m.value}
            </span>
            {m.delta && (
              <span
                className={cn(
                  "text-[10px] font-medium tabular-nums",
                  m.deltaDir === "up" && "text-green",
                  m.deltaDir === "down" && "text-red",
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

function SessionsView({ onSelect, sessions, loading, error, onRetry }: {
  onSelect: (id: string) => void; sessions: SessionRecord[]; loading: boolean; error?: string; onRetry: () => void;
}) {
  type SortKey = keyof SessionRecord | "cacheHitRatio";
  const [sortKey, setSortKey] = useState<SortKey>("startedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [partialOnly, setPartialOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const hasRecordedErrors = (s: SessionRecord) => (s.toolErrorCount ?? 0) + (s.modelErrorCount ?? 0) + (s.turnErrorCount ?? 0) > 0;

  const sorted = useMemo(() => {
    const filtered = filter
      ? sessions.filter(
          (s) =>
            s.id.includes(filter) ||
            s.title?.toLowerCase().includes(filter.toLowerCase()) ||
            s.agent?.toLowerCase().includes(filter.toLowerCase()) ||
            s.model?.toLowerCase().includes(filter.toLowerCase()) ||
            s.harness.includes(filter)
        )
      : sessions;
    return filtered.filter(s => (!errorsOnly || hasRecordedErrors(s)) && (!partialOnly || s.capture?.partial)).sort((a, b) => {
      const av = sortKey === "cacheHitRatio" ? cacheRatio(a) : a[sortKey];
      const bv = sortKey === "cacheHitRatio" ? cacheRatio(b) : b[sortKey];
      const aUnknown = av == null || (typeof av === "number" && !Number.isFinite(av));
      const bUnknown = bv == null || (typeof bv === "number" && !Number.isFinite(bv));
      if (aUnknown || bUnknown) return aUnknown === bUnknown ? 0 : aUnknown ? 1 : -1;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [sessions, filter, sortKey, sortDir, errorsOnly, partialOnly]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || target?.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (event.key === "j" || event.key === "k") {
        if (!sorted.length) return;
        event.preventDefault();
        const current = sorted.findIndex(s => s.id === selectedId);
        const next = Math.max(0, Math.min(sorted.length - 1, current < 0 ? 0 : current + (event.key === "j" ? 1 : -1)));
        setSelectedId(sorted[next].id);
        document.getElementById(`session-row-${sorted[next].id}`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && selectedId && sorted.some(s => s.id === selectedId) && !target?.closest('button,a,summary')) {
        event.preventDefault(); onSelect(selectedId);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [sorted, selectedId, onSelect]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortHead({ col, label, desktop = false }: { col: SortKey; label: string; desktop?: boolean }) {
    const active = sortKey === col;
    return (
      <TableHead
        className={cn("select-none", desktop && "session-desktop", active && "text-foreground")}
        aria-sort={active ? sortDir === "asc" ? "ascending" : "descending" : "none"}
      >
        <button className="rounded py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => toggleSort(col)}>{label}{active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button>
      </TableHead>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="page-title">Session review</h1><p className="page-description">Understand what happened. Decide what to change in your agent environment.</p></div>
        <Button variant="ghost" size="sm" onClick={onRetry} disabled={loading} aria-label="Refresh sessions"><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />Refresh</Button>
      </div>
      <div className="list-toolbar">
        <div className="view-tabs" role="group" aria-label="Session views">
          <button aria-pressed={!errorsOnly && !partialOnly} onClick={() => { setErrorsOnly(false); setPartialOnly(false); }}>All sessions<span>{sessions.length}</span></button>
          <button aria-pressed={errorsOnly} onClick={() => { setErrorsOnly(true); setPartialOnly(false); }}>Recorded errors<span>{sessions.filter(hasRecordedErrors).length}</span></button>
          <button aria-pressed={partialOnly} onClick={() => { setPartialOnly(true); setErrorsOnly(false); }}>Partial capture<span>{sessions.filter(s => s.capture?.partial).length}</span></button>
        </div>
        <div className="relative ml-auto w-full sm:w-56"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          ref={filterRef}
          className="pl-8 pr-7"
          placeholder="Filter sessions…"
          aria-label="Filter loaded sessions"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <kbd className="pointer-events-none absolute right-2 top-1.5">/</kbd></div>
      </div>

      {error && <div role="alert" className="flex items-center justify-between gap-3 text-sm"><p>Cannot refresh sessions. {sessions.length ? "Showing the last loaded snapshot." : "This is a read error, not an empty history."} <span className="text-secondary-foreground">{error}</span></p><Button onClick={onRetry} disabled={loading}>Retry</Button></div>}

      {loading && !sessions.length ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="table-frame">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead col="title" label="Session" />
                <SortHead col="startedAt" label="Started" desktop />
                <SortHead col="model" label="Model" desktop />
                <SortHead col="turnCount" label="Turns" desktop />
                <SortHead col="promptTokens" label="Input tokens" desktop />
                <SortHead col="cacheHitRatio" label="Cached input" desktop />
                <SortHead col="costTotal" label="Recorded cost" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s) => {
                const hit = cacheRatio(s);
                return (
                  <TableRow
                    key={s.id}
                    id={`session-row-${s.id}`}
                    data-state={s.id === selectedId ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => onSelect(s.id)}
                  >
                    <TableCell className="min-w-40 max-w-52 sm:min-w-64 sm:max-w-sm">
                      <div className="session-name">
                      {hasRecordedErrors(s) ? <CircleAlert className="session-state error" aria-label="Recorded errors" /> : <Circle className="session-state" aria-label="No recorded errors" />}
                      <div className="min-w-0">
                      <a href={`#/sessions/${s.id}`} className="block truncate rounded font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" title={s.title || "Untitled session"} onClick={e => { e.stopPropagation(); if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onSelect(s.id); }}>{s.title || "Untitled session"}</a>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{s.harness}{s.agent ? ` · ${s.agent}` : ""}{s.capture?.partial ? " · Partial capture" : ""}</span>
                      {hasRecordedErrors(s) && <span className="block text-xs text-amber">{[s.toolErrorCount ? `${s.toolErrorCount} tool ${s.toolErrorCount === 1 ? "error" : "errors"}` : "", s.modelErrorCount ? `${s.modelErrorCount} model ${s.modelErrorCount === 1 ? "error" : "errors"}` : "", s.turnErrorCount ? `${s.turnErrorCount} turn ${s.turnErrorCount === 1 ? "error" : "errors"}` : ""].filter(Boolean).join(" · ")}</span>}
                      </div></div>
                    </TableCell>
                    <TableCell className="session-desktop text-muted-foreground">{ago(s.startedAt)}</TableCell>
                    <TableCell className="session-desktop text-muted-foreground">{s.model ?? "—"}</TableCell>
                    <TableCell className="session-desktop text-right tabular-nums">{fmt(s.turnCount)}</TableCell>
                    <TableCell className="session-desktop text-right tabular-nums text-muted-foreground">{fmt(s.promptTokens)}</TableCell>
                    <TableCell className="session-desktop">
                      <span className={cn(
                        "block text-right tabular-nums font-medium",
                        !Number.isFinite(hit) && "text-secondary-foreground"
                      )}>
                        {fmtRatio(hit)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{fmtCost(s.costTotal)}</TableCell>
                  </TableRow>
                );
              })}
              {!sorted.length && !error && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-12">
                    {sessions.length ? "No loaded sessions match these filters. No recorded errors does not prove a successful run." : <>
                       <p className="text-base font-medium text-foreground">Your next session starts here.</p>
                      <p>The collector is reachable; instrumentation has not been verified.</p>
                      <details className="mx-auto mt-3 max-w-lg text-left"><summary className="cursor-pointer text-primary">Connect OpenCode or import saved sessions</summary>
                        <p className="mt-2">Add the plugin to your project&apos;s OpenCode configuration:</p><pre className="body-pre">{'{ "plugins": ["opencode-agent-profiler"] }'}</pre>
                        <p className="mt-2">For existing OpenCode V2 history, run <code>agent-profiler import opencode</code>. Data stays in the local collector; imports include saved content.</p>
                      </details>
                    </>}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <div className="session-list-footer flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-muted-foreground"><span>{sorted.length} of {sessions.length} loaded sessions · Latest 200</span><span className="hidden sm:flex items-center gap-1.5"><kbd>J</kbd><kbd>K</kbd> select <span className="mx-1">·</span><kbd>Enter</kbd> open</span></div>
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

  const maxCost = Math.max(...turns.map((t) => t.cost ?? 0), 0.0001);
  const n = turns.length;

  const w = 100; // SVG user units per column (percent-like; viewBox sets scale)
  const totalW = n * w + padL + padR;
  const totalH = TOTAL_H + padTop + labelH;

  // Unknown turns create gaps, not a line implying an observed transition.
  const polylines: string[][] = [[]];
  turns.forEach((t, i) => {
      const cx = padL + i * w + w / 2;
      const ratio = cacheRatio(t);
      if (!Number.isFinite(ratio)) { if (polylines.at(-1)!.length) polylines.push([]); return; }
      const y = padTop + BAR_H + LINE_H * (1 - ratio);
      polylines.at(-1)!.push(`${cx},${y}`);
  });

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-primary" /> recorded cost/turn
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 border-t-2 border-amber" /> cached input %
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
                stroke="var(--color-border)"
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
            stroke="var(--color-amber)"
            strokeWidth={0.8}
            strokeDasharray="3 3"
            opacity={0.5}
          />
          <text
            x={padL - 2}
            y={padTop + BAR_H + LINE_H * 0.5 + 1}
            textAnchor="end"
            fontSize={6}
            fill="var(--color-amber)"
            opacity={0.7}
          >50%</text>

          {/* Bars */}
          {turns.map((t, i) => {
            if (t.cost == null || t.cost < 0) return null;
            const bh = t.cost === 0 ? 0 : Math.max(2, (t.cost / maxCost) * BAR_H);
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
                fill="var(--color-primary)"
                opacity={0.85}
                className="cursor-pointer hover:opacity-100 transition-opacity"
                onClick={() => onTurnClick(t.id)}
              >
                <title>{`Turn ${t.idx + 1}: ${fmtCost(t.cost)}`}</title>
              </rect>
            );
          })}

          {/* Cache hit polyline */}
          {polylines.filter(points => points.length > 1).map((points, index) => <polyline
            key={index}
            points={points.join(" ")}
            fill="none"
            stroke="var(--color-amber)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            opacity={0.9}
          />)}
          {turns.map((t, i) => {
            const ratio = cacheRatio(t);
            if (!Number.isFinite(ratio)) return null;
            const cx = padL + i * w + w / 2;
            const cy = padTop + BAR_H + LINE_H * (1 - ratio);
            return (
              <circle
                key={t.id}
                cx={cx}
                cy={cy}
                r={3}
                fill="var(--color-amber)"
                opacity={0.9}
                className="cursor-pointer"
                onClick={() => onTurnClick(t.id)}
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
              fill="var(--color-muted-foreground)"
            >
              {t.idx + 1}
            </text>
          ))}

          {/* Y-axis cost labels */}
          <text x={padL - 2} y={padTop + 4} textAnchor="end" fontSize={6} fill="var(--color-muted-foreground)">
            {fmtCost(maxCost)}
          </text>
          <text x={padL - 2} y={padTop + BAR_H} textAnchor="end" fontSize={6} fill="var(--color-muted-foreground)">
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
  refreshKey,
  onTurnSelect,
  onCacheView,
  onPromptView,
}: {
  sessionId: string;
  refreshKey: string;
  onTurnSelect: (turnId: string) => void;
  onCacheView: () => void;
  onPromptView: (llmCallId: string) => void;
}) {
  const { data, error, refresh } = useResource(`session:${sessionId}`, refreshKey, async signal => {
    const [s, t, i] = await Promise.all([api.session(sessionId, signal), api.turns(sessionId, signal), api.sessionInsights(sessionId, signal)]);
    return { session: s.session, turns: t.turns, insights: i.insights };
  });
  const session = data?.session;
  const turns = data?.turns ?? [];
  const insights = data?.insights ?? [];
  const [profiling, setProfiling] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const [tab, setTab] = useState<"review" | "execution">("review");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setTab("review"); setCopied(false); }, [sessionId]);

  async function runProfile() {
    setProfiling(true);
    try {
      setProfileError(undefined);
      await api.profile(sessionId);
      refresh();
    } catch (cause) {
      setProfileError(cause instanceof Error ? cause.message : "Analysis failed");
    } finally {
      setProfiling(false);
    }
  }

  if (!session) {
    if (error) return <ReadError error={error} onRetry={refresh} />;
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
  const knownCostTurns = turns.filter((t): t is TurnRecord & { cost: number } => t.cost != null);
  const peakTurn = knownCostTurns.length > 0 ? knownCostTurns.reduce((a, b) => (b.cost > a.cost ? b : a)) : null;
  const peakFrac = peakTurn && session.costTotal != null && session.costTotal > 0 ? peakTurn.cost / session.costTotal : 0;
  const cacheTurns = turns.filter(t => Number.isFinite(cacheRatio(t)));
  const lowestCacheTurn = cacheTurns.length > 0
    ? cacheTurns.reduce((a, b) => {
        const ra = cacheRatio(a);
        const rb = cacheRatio(b);
        return rb < ra ? b : a;
      })
    : null;
  const inspectFinding = (ins: Insight) => typeof ins.evidence.turnId === "string" ? () => onTurnSelect(ins.evidence.turnId as string)
    : ins.scopeType === "turn" ? () => onTurnSelect(ins.scopeId)
    : typeof ins.evidence.llmCallId === "string" ? () => onPromptView(ins.evidence.llmCallId as string)
    : ins.kind.startsWith("cache.") ? onCacheView : undefined;

  return (
    <div className="space-y-6">
      <ReadError error={error ?? profileError} onRetry={refresh} />
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-0.5 min-w-0 max-w-3xl">
          <h1 className="page-title break-words">{session.title || "Untitled session"}</h1>
          <p className="page-description">{session.harness} · {session.model || "Model not recorded"} · {new Date(session.startedAt).toLocaleString()}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCacheView}>Cache detail</Button>
          <Button variant="outline" size="sm" onClick={runProfile} disabled={profiling}>
            {profiling ? <><Loader2 className="h-3 w-3 animate-spin" /> Running…</> : "Refresh findings"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border" role="group" aria-label="Session sections">
        <button className={cn("px-3 py-2.5 text-[13px] border-b-2", tab === "review" ? "border-primary text-foreground" : "border-transparent text-muted-foreground")} aria-pressed={tab === "review"} onClick={() => setTab("review")}>Review <span className="ml-1.5 text-muted-foreground">{insights.length}</span></button>
        <button className={cn("px-3 py-2.5 text-[13px] border-b-2", tab === "execution" ? "border-primary text-foreground" : "border-transparent text-muted-foreground")} aria-pressed={tab === "execution"} onClick={() => setTab("execution")}>Turns & calls <span className="ml-1.5 text-muted-foreground">{turns.length}</span></button>
      </div>
      <div className="review-layout"><div className="min-w-0 space-y-6">
      {tab === "review" && <>
      {session.capture?.partial && (
        <div className="workspace-note"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p>
          {session.capture.source === "opencode-import" ? "Imported history (partial)." : "Partial capture."} Exact outgoing prompts and historical tool schemas may be unavailable.
          Missing usage is shown as Unknown, not zero. Recorded cost is not necessarily billed spend.
        </p></div>
      )}
      {peakTurn && peakFrac > 0.25 && (
        <p className="text-[13px] leading-relaxed text-secondary-foreground">
          <button className="text-foreground underline" onClick={() => onTurnSelect(peakTurn.id)}>Turn {peakTurn.idx + 1}</button> accounts for{" "}
          <span className="font-semibold text-amber">{fmtRatio(peakFrac)}</span> of session cost
          {lowestCacheTurn && lowestCacheTurn.id !== peakTurn.id && (
            <>
              {". "}Lowest recorded cached-input share at turn {lowestCacheTurn.idx + 1}{" "}
              <span className="font-semibold">
                ({fmtRatio(cacheRatio(lowestCacheTurn))})
              </span>
            </>
          )}.
        </p>
      )}

      {/* Top-priority insights — before metrics, not after */}
      {topInsights.length > 0 && (
        <section><h2 className="section-heading">Findings to investigate</h2><p className="section-caption mb-4">Recorded observations, not a verdict on your configuration.</p><div className="findings-list">
          {topInsights.slice(0, 3).map((ins) => (
            <InsightCard key={ins.id} insight={ins} onInspect={inspectFinding(ins)} />
          ))}
          {topInsights.length > 3 && (
            <details className="text-xs"><summary className="cursor-pointer py-2 text-primary">Show {topInsights.length - 3} more findings</summary><div className="space-y-2">{topInsights.slice(3).map(ins => <InsightCard key={ins.id} insight={ins} onInspect={inspectFinding(ins)} />)}</div></details>
          )}
        </div></section>
      )}

      {!topInsights.length && <div className="empty-workspace"><div><h2>No current findings</h2><p>There’s no flagged evidence in this capture. That doesn’t establish run quality. Inspect the turns to review what your agent actually did.</p><Button className="mt-5" onClick={() => setTab("execution")}>Explore turns & calls<ChevronRight className="h-3.5 w-3.5" /></Button></div></div>}
      <p className="max-w-[72ch] border-t border-border pt-5 text-xs leading-relaxed text-muted-foreground">Refine one thing at a time. Inspect the original evidence before changing instructions, a skill, or a tool definition. This capture does not establish which configuration caused an outcome.</p>
      </>}

      {/* Composite timeline */}
      {tab === "execution" && turns.length > 1 && (
        <details className="rounded-md border border-border px-4 py-3"><summary className="section-heading cursor-pointer">Cost & cached input across turns</summary><div className="pt-4">
          <SessionTimeline turns={turns} onTurnClick={onTurnSelect} />
        </div></details>
      )}

      {/* Slim turns table — 4 columns, not 8 */}
      {tab === "execution" && <div className="space-y-3">
        <h2 className="section-heading">
          Turns ({turns.length})
        </h2>
        <div className="table-frame">
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
                const tr = cacheRatio(t);
                return (
                  <TableRow key={t.id} className="cursor-pointer" onClick={() => onTurnSelect(t.id)}>
                    <TableCell className="text-muted-foreground tabular-nums">{t.idx + 1}</TableCell>
                    <TableCell className="max-w-xs truncate">
                      <a href={`#/sessions/${sessionId}/turns/${t.id}`} className="hover:underline" onClick={e => { e.stopPropagation(); if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onTurnSelect(t.id); }}>{t.userText?.slice(0, 100) || "Inspect turn"}</a>
                    </TableCell>
                    <TableCell className="tabular-nums font-medium">{fmtCost(t.cost)}</TableCell>
                    <TableCell>
                      <span className={cn(
                        "tabular-nums",
                        !Number.isFinite(tr) ? "text-muted-foreground" : "text-secondary-foreground"
                      )}>
                        {fmtRatio(tr)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {t.endSignal === "error" ? (
                        <Badge variant="critical">error</Badge>
                      ) : t.endSignal === "user_stopped" ? (
                        <Badge variant="warn">stopped</Badge>
                      ) : !t.endSignal ? (
                        <span className="text-muted-foreground">Unknown</span>
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
      </div>}
      </div><aside className="properties" aria-label="Session properties">
        <h2 className="section-heading">Properties</h2>
        <dl className="property-list">
          <div><dt>Harness</dt><dd>{session.harness}</dd></div>
          <div><dt>Model</dt><dd>{session.model || "Unknown"}</dd></div>
          <div><dt>Capture</dt><dd>{session.capture?.source === "opencode-import" ? "Imported history" : session.capture?.source === "live" ? "Live capture" : "Source not recorded"}{session.capture?.partial ? " · Partial" : ""}</dd></div>
          <div><dt>Turns</dt><dd>{fmt(session.turnCount)}</dd></div>
          <div><dt>Model calls</dt><dd>{fmt(session.llmCallCount)}</dd></div>
          <div><dt>Tool calls</dt><dd>{fmt(session.toolCallCount)}</dd></div>
          <div><dt>Input tokens</dt><dd>{fmt(session.promptTokens)}</dd></div>
          <div><dt>Cached input</dt><dd>{fmtRatio(hitRatio)}</dd></div>
          <div><dt>Recorded cost</dt><dd>{fmtCost(session.costTotal)}</dd></div>
        </dl>
        <div className="mt-6 border-t border-border pt-5"><p className="text-xs text-muted-foreground">Session ID</p><code className="mt-2 block break-all text-[11px] text-secondary-foreground">{session.id}</code><Button variant="ghost" size="sm" className="mt-2" onClick={async () => { try { await navigator.clipboard.writeText(session.id); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy ID"}</Button></div>
        <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Unknown is missing evidence, not zero. Recorded cost may differ from billed spend.</p>
      </aside></div>
    </div>
  );
}

// ── Turn detail / recorded span durations ─────────────────────────────────────

function TurnDetailView({
  turnId,
  sessionId,
  refreshKey,
  allTurns = [],
  onPromptView,
}: {
  turnId: string;
  sessionId: string;
  refreshKey: string;
  allTurns?: TurnRecord[];
  onPromptView: (llmCallId: string) => void;
}) {
  const { data, error, refresh } = useResource(`turn:${turnId}`, refreshKey, async signal => {
    const [t, l, tools] = await Promise.all([api.turn(turnId, signal), api.llmCalls(turnId, signal), api.toolCalls(turnId, signal)]);
    return { turn: t.turn, llmCalls: l.llmCalls, toolCalls: tools.toolCalls };
  });
  const turn = data?.turn;
  const llmCalls = data?.llmCalls ?? [];
  const toolCalls = data?.toolCalls ?? [];
  const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
  const [blobCache, setBlobCache] = useState<Record<string, string>>({});
  const [blobError, setBlobError] = useState<string>();
  const currentTurn = useRef(turnId);
  currentTurn.current = turnId;

  useEffect(() => { setSelectedSpan(null); setBlobCache({}); setBlobError(undefined); }, [turnId]);

  async function loadBlob(ref: string) {
    if (Object.hasOwn(blobCache, ref)) {
      setBlobCache(cache => { const next = { ...cache }; delete next[ref]; return next; });
      return;
    }
    const requestedTurn = turnId;
    try {
      setBlobError(undefined);
      const text = await api.blob(ref);
      if (currentTurn.current === requestedTurn) setBlobCache((c) => ({ ...c, [ref]: text }));
    } catch (cause) {
      if (currentTurn.current === requestedTurn) setBlobError(cause instanceof Error ? cause.message : "Evidence unavailable");
    }
  }

  if (!turn) {
    if (error) return <ReadError error={error} onRetry={refresh} />;
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  type SpanItem = { type: "llm" | "tool"; id: string; name: string; latencyMs: number | null; record: LlmCallRecord | ToolCallRecord };
  const spans: SpanItem[] = [
    ...llmCalls.map((c) => ({ type: "llm" as const, id: c.id, name: c.model, latencyMs: c.latencyMs, record: c })),
    ...toolCalls.map((c) => ({ type: "tool" as const, id: c.id, name: c.name, latencyMs: c.latencyMs, record: c })),
  ].sort((a, b) => (b.latencyMs ?? -1) - (a.latencyMs ?? -1));

  const maxMs = spans.reduce((m, x) => Math.max(m, x.latencyMs ?? 0), 1);

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
      <ReadError error={error} onRetry={refresh} />
      {blobError && <p role="alert" className="workspace-note">{blobError}. Select the evidence button to retry.</p>}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h1 className="page-title">Turn {turn.idx + 1}</h1>
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
        { label: "Cached input", value: fmtRatio(cacheRatio(turn)) },
        { label: "LLM calls", value: fmt(turn.llmRoundTrips) },
        { label: "Prompt tok", value: fmt(turn.promptTokens) },
        { label: "Completion tok", value: fmt(turn.completionTokens) },
      ]} />
      <Separator />

      {turn.userText && (
        <div className="space-y-1.5">
          <h2 className="section-heading">User message</h2>
          <pre className="body-pre">{turn.userText}</pre>
        </div>
      )}

      {turn.assistantText && (
        <div className="space-y-1.5">
          <h2 className="section-heading">Assistant response</h2>
          <pre className="body-pre">
            {turn.assistantText}
          </pre>
        </div>
      )}

      {/* Waterfall — Tufte: 2 colors, no co-located tables */}
      {spans.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="section-heading">
              Span durations — longest first; select to inspect
            </h2>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-primary" /> LLM
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-amber" /> Tool
              </span>
            </div>
          </div>
          <div className="space-y-1">
            {spans.map((span) => {
              const pct = span.latencyMs == null ? 0 : Math.max(2, (span.latencyMs / maxMs) * 100);
              const isSelected = selectedSpan === span.id;
              return (
                <div key={span.id} className="rounded-md overflow-hidden border border-transparent hover:border-border transition-colors">
                  <button
                    className="flex w-full items-center gap-3 min-h-10 px-2 text-left"
                    aria-expanded={isSelected}
                    aria-label={`Inspect ${span.type === "llm" ? "model call" : "tool"} ${span.name}, ${fmtMs(span.latencyMs)}`}
                    onClick={() => setSelectedSpan(isSelected ? null : span.id)}
                  >
                    <span className="w-24 sm:w-40 shrink-0 text-xs text-secondary-foreground truncate" title={span.name}>
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
                  </button>
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

function CachePanelView({ sessionId, refreshKey, onTurnSelect }: { sessionId: string; refreshKey: string; onTurnSelect: (id: string) => void }) {
  const { data, error, refresh } = useResource(`cache:${sessionId}`, refreshKey, async signal => {
    const [s, t] = await Promise.all([api.session(sessionId, signal), api.turns(sessionId, signal)]);
    return { session: s.session, turns: t.turns };
  });
  const session = data?.session;
  const turns = data?.turns ?? [];

  if (!session) {
    if (error) return <ReadError error={error} onRetry={refresh} />;
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
    ratio: cacheRatio(t),
    prompt: t.promptTokens,
  }));

  const CHART_H = 120;
  const padL = 28, padR = 8, padTop = 8, labelH = 30;
  const n = turnSeries.length || 1;
  const colW = 40;
  const totalW = n * colW + padL + padR;
  const totalH = CHART_H + padTop + labelH;

  return (
    <div className="space-y-5">
      <h1 className="page-title">Cache detail</h1>
      <ReadError error={error} onRetry={refresh} />
      <p className="text-sm text-secondary-foreground">Cached-input share = recorded cache-read tokens ÷ recorded total input tokens. It is not a fraction of model context capacity or a diagnosis of cache misses.</p>

      <MetricRow metrics={[
        { label: "Token-weighted cached input", value: fmtRatio(sessionHitRatio) },
        { label: "Cache-read tok", value: fmt(session.cacheReadTokens) },
        { label: "Cache-write tok", value: fmt(session.cacheWriteTokens) },
      ]} />
      <Separator />

      {/* 100% normalized bars — Tufte: each bar same height, fraction is the signal */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="section-heading">
            Cached input per turn — select a turn to inspect
          </h2>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm bg-green" /> cache read
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
                  <line x1={padL} y1={y} x2={totalW - padR} y2={y} stroke="var(--color-border)" strokeWidth={0.5} />
                  <text x={padL - 2} y={y + 2} textAnchor="end" fontSize={6} fill="var(--color-muted-foreground)">
                    {Math.round(frac * 100)}%
                  </text>
                </g>
              );
            })}

            {/* Session-average reference line */}
            {Number.isFinite(sessionHitRatio) && <><line
              x1={padL}
              y1={padTop + CHART_H * (1 - sessionHitRatio)}
              x2={totalW - padR}
              y2={padTop + CHART_H * (1 - sessionHitRatio)}
              stroke="var(--color-amber)"
              strokeWidth={1}
              strokeDasharray="4 2"
            />
            <text
              x={totalW - padR}
              y={padTop + CHART_H * (1 - sessionHitRatio) - 2}
              textAnchor="end"
              fontSize={6}
              fill="var(--color-amber)"
            >
              session {fmtRatio(sessionHitRatio)}
            </text></>}

            {/* Normalized bars */}
            {turnSeries.map((t, i) => {
              const x = padL + i * colW + colW * 0.15;
              const bw = colW * 0.7;
              const fullH = CHART_H;
              const known = Number.isFinite(t.ratio);
              const hitH = known ? fullH * t.ratio : 0;
              return (
                <a key={t.id} href={`#/sessions/${sessionId}/turns/${t.id}`} aria-label={`Inspect turn ${t.idx}: ${fmtRatio(t.ratio)} cached input, ${fmt(t.prompt)} total input tokens`} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onTurnSelect(t.id); }}>
                  <title>{`Turn ${t.idx}: ${fmtRatio(t.ratio)} cached input; ${fmt(t.prompt)} total input tokens`}</title>
                  {/* Full bar (prompt total) */}
                  <rect x={x} y={padTop} width={bw} height={fullH} rx={2} fill={known ? "var(--color-secondary)" : "none"} stroke={known ? "none" : "var(--color-border)"} strokeDasharray={known ? undefined : "3 3"} />
                  {/* Cache read portion */}
                  {known ? <rect
                    x={x}
                    y={padTop + fullH - hitH}
                    width={bw}
                    height={hitH}
                    rx={2}
                    fill="var(--color-green)"
                    opacity={0.85}
                  /> : <text x={x + bw / 2} y={padTop + fullH / 2} textAnchor="middle" fontSize={6} fill="var(--color-secondary-foreground)">Unknown</text>}
                  {/* Turn label */}
                  <text x={x + bw / 2} y={totalH - 16} textAnchor="middle" fontSize={7} fill="var(--color-secondary-foreground)">
                    {t.idx}
                  </text>
                  <text x={x + bw / 2} y={totalH - 4} textAnchor="middle" fontSize={6} fill="var(--color-secondary-foreground)">{fmt(t.prompt)} tok</text>
                </a>
              );
            })}
          </svg>
        </div>
        <p className="text-xs text-secondary-foreground">Input volume is shown below each turn. Gaps are unknown, not zero. The dashed session reference is token-weighted, not a performance target.</p>
      </div>
    </div>
  );
}

// ── Prompt Inspector — treemap strip only (no redundant table) ────────────────

const SEG_COLORS: Record<string, string> = {
  system: "var(--color-primary)",
  tool: "var(--color-amber)",
  mcp: "var(--color-purple)",
  skill: "var(--color-green)",
  user: "var(--color-muted-foreground)",
  assistant: "var(--color-purple)",
  instructions: "var(--color-primary)",
};
function segColor(k: string) { return SEG_COLORS[k] ?? "var(--color-muted-foreground)"; }

function PromptInspectorView({ llmCallId, sessionId }: { llmCallId: string; sessionId: string }) {
  const { data, error, refresh } = useResource(`prompt:${llmCallId}`, sessionId, async signal => {
    const [{ segments }, { turns }] = await Promise.all([api.segments(llmCallId, signal), api.turns(sessionId, signal)]);
    const batches = await Promise.all(turns.map(t => api.llmCalls(t.id, signal)));
    const llmCall = batches.flatMap(b => b.llmCalls).find(c => c.id === llmCallId);
    if (!llmCall) throw new Error("This model call was not found in the session's recorded turns");
    return { segments, llmCall };
  });
  const segments = data?.segments ?? [];
  const llmCall = data?.llmCall;
  const { data: messages, error: messagesError, refresh: retryMessages } = useResource(`messages:${llmCallId}`, llmCall?.inputMessagesRef ?? "none", async signal => llmCall?.inputMessagesRef ? api.blob(llmCall.inputMessagesRef, signal) : null);
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null);
  useEffect(() => setSelectedSeg(null), [llmCallId]);

  const totalChars = segments.reduce((s, x) => s + x.charLen, 0);
  const totalTokens = segments.reduce((s, x) => s + x.tokenEst, 0);

  if (!llmCall) {
    if (error) return <ReadError error={error} onRetry={refresh} />;
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-0.5">
        <h1 className="page-title">Prompt inspector</h1>
        <code className="text-[11px] text-muted-foreground font-mono">{llmCallId}</code>
      </div>
      <ReadError error={error} onRetry={refresh} />
      <ReadError error={messagesError} onRetry={retryMessages} />
      <p className="page-description">Inspect what was captured before changing an instruction, skill, or tool definition. Missing source attribution is not reconstructed.</p>

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
          <h2 className="section-heading">
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
                      <button
                        className={cn(
                          "h-full cursor-pointer transition-opacity hover:opacity-75",
                          selectedSeg === i && "ring-2 ring-ring ring-inset"
                        )}
                         style={{ width: `${pct}%`, background: segColor(seg.sourceKind) }}
                         aria-label={`Inspect ${seg.sourceName}, approximately ${fmt(seg.tokenEst)} tokens`}
                         aria-pressed={selectedSeg === i}
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
            No segment attribution was recorded. Captured messages:
          </p>
          <pre className="body-pre">{messages}</pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No prompt data for this LLM call.</p>
      )}
      {segments.length > 0 && messages && <details className="rounded-md border border-border p-4"><summary className="section-heading">Captured request messages</summary><pre className="body-pre mt-3">{messages}</pre></details>}
    </div>
  );
}

// ── Compare — deltas ranked by magnitude, not flat grid ───────────────────────

function CompareView() {
  const { data, loading, error, refresh } = useResource("compare", "initial", async () => api.compare());
  const result = data?.compare;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!result?.metrics.length) {
    if (error) return <ReadError error={error} onRetry={refresh} />;
    return (
      <div><h1 className="page-title">Compare</h1><div className="empty-workspace"><div><h2>Nothing comparable yet</h2><p>Sessions need recorded usage and associated turns to join a comparison. Missing measurements are excluded, never replaced with zeros.</p></div></div></div>
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
  }: {
    label: string;
    delta: number | null;
    ciLow: number | null;
    ciHigh: number | null;
    format: (v: number) => string;
  }) {
    return (
      <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="text-right">
          <span className="text-sm font-semibold tabular-nums">
            {delta == null ? "Unknown" : `${delta >= 0 ? "+" : "−"}${format(Math.abs(delta))}`}
          </span>
          <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
            {ciLow == null || ciHigh == null ? "Interval not estimated" : `95% CI [${format(ciLow)}, ${format(ciHigh)}]`}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="page-title">Compare</h1>
      <ReadError error={error} onRetry={refresh} />
      <p className="text-sm text-secondary-foreground">{result.comparisonBasis ?? "Observed, unmatched workloads; differences do not establish a better harness."} {result.excludedSessionCount ?? 0} sessions excluded for missing measurements, missing turns, or unmatched calls.</p>

      {topInsights.length > 0 && (
        <div className="space-y-2">
          {topInsights.map((ins) => <InsightCard key={ins.id} insight={ins} />)}
        </div>
      )}

      <div className="space-y-2">
        <h2 className="section-heading">
          Per-harness metrics
        </h2>
        <div className="table-frame">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Harness</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Cached input %</TableHead>
                <TableHead>Tokens/turn</TableHead>
                <TableHead>Cost/turn</TableHead>
                <TableHead>Model duration/turn</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.metrics.map((m) => (
                <TableRow key={m.harness}>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <Circle className="h-3 w-3 text-muted-foreground" />
                      {m.harness}
                    </span>
                  </TableCell>
                  <TableCell className="tabular-nums">{fmt(m.sessionCount)}</TableCell>
                  <TableCell>
                    <span className={cn(
                      "tabular-nums",
                      "text-foreground"
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
          <h2 className="section-heading">
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
                />
                <DeltaRow
                  label="Tokens / turn"
                  delta={d.tokensPerTurnDelta.delta}
                  ciLow={d.tokensPerTurnDelta.ciLow}
                  ciHigh={d.tokensPerTurnDelta.ciHigh}
                  format={(v) => fmt(v, 0)}
                />
                <DeltaRow
                  label="Cached input share"
                  delta={d.cacheHitRatioDelta.delta}
                  ciLow={d.cacheHitRatioDelta.ciLow}
                  ciHigh={d.cacheHitRatioDelta.ciHigh}
                  format={fmtRatio}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Omnibar ───────────────────────────────────────────────────────────────────

const STATIC_COMMANDS = [
  { label: "Sessions", action: "sessions", icon: LayoutDashboard },
  { label: "Cross-Harness Compare", action: "compare", icon: GitCompare },
  { label: "Session activity", action: "live-tail", icon: Radio },
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
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const navigatedRef = useRef<"page" | "activity" | null>(null);
  const listId = useId();

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const cmds = STATIC_COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
    const sess = sessions
      .filter((s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        (s.agent ?? "").toLowerCase().includes(q) ||
        (s.model ?? "").toLowerCase().includes(q)
      )
      .slice(0, 8)
      .map((s) => ({
        label: s.title || `${s.agent ?? s.id.slice(0, 8)} — ${s.model ?? "?"}`,
        sublabel: `${s.id} · ${ago(s.startedAt)}`,
        action: `session:${s.id}`,
        icon: LayoutDashboard,
      }));
    return [
      ...cmds.map((c) => ({ ...c, sublabel: "command", icon: c.icon })),
      ...sess,
    ];
  }, [query, sessions]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items, listId, open]);

  useEffect(() => { setActiveIndex(0); }, [items]);

  function select(action: string) {
    navigatedRef.current = action === "live-tail" ? "activity" : "page";
    if (action === "sessions") onNavigate({ page: "sessions" });
    else if (action === "compare") onNavigate({ page: "compare" });
    else if (action === "live-tail") onLiveTail();
    else if (action.startsWith("session:")) onNavigate({ page: "session", id: action.slice(8) });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="p-0 gap-0 overflow-hidden max-w-xl max-h-[75dvh] flex flex-col"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          navigatedRef.current = null;
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (navigatedRef.current === "page") document.querySelector<HTMLElement>("main")?.focus();
          else if (navigatedRef.current === "activity" && document.querySelector("#session-activity")) document.querySelector<HTMLElement>("#session-activity")?.focus();
          else if (openerRef.current?.isConnected) openerRef.current.focus();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            event.stopPropagation();
            inputRef.current?.focus();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (items.length) setActiveIndex(index => Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
            inputRef.current?.focus();
          }
        }}
      >
        <DialogTitle className="sr-only">Search sessions and commands</DialogTitle>
        <DialogDescription className="sr-only">Search loaded sessions by title, ID, agent, or model. Use the arrow keys to select a result and Enter to open it.</DialogDescription>
        <div className="flex shrink-0 items-center gap-3 px-4 border-b border-border">
          <Command className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 min-w-0 py-4 pr-8 bg-transparent text-sm text-foreground placeholder:text-secondary-foreground outline-none"
            aria-label="Search sessions and commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            placeholder="Search sessions, go to view…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (items[activeIndex]) select(items[activeIndex].action);
              }
            }}
          />
        </div>
        <div id={listId} role="listbox" aria-label="Matching commands and sessions" className="min-h-0 max-h-80 overflow-y-auto">
          {items.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-secondary-foreground">No matching loaded sessions or commands</p>
          )}
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.action}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                className={cn("w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors text-sm", index === activeIndex && "bg-accent")}
                onPointerMove={() => setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => select(item.action)}
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-foreground">{item.label}</span>
                  {item.sublabel && (
                    <span className="block truncate text-xs text-secondary-foreground">{item.sublabel}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{items.length} {items.length === 1 ? "result" : "results"} in loaded sessions and commands</p>
        <p className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-secondary-foreground">↑↓ Navigate · Enter Open · Esc Close</p>
      </DialogContent>
    </Dialog>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function Breadcrumb({
  view,
  sessions,
  onNavigate,
}: {
  view: View;
  sessions: SessionRecord[];
  onNavigate: (v: View) => void;
}) {
  const crumbs: { label: string; view: View }[] = [
    { label: "Sessions", view: { page: "sessions" } },
  ];
  const sid = view.page === "session" ? view.id : "sessionId" in view ? view.sessionId : null;
  const title = sessions.find(s => s.id === sid)?.title || "Session";
  if (view.page === "session") crumbs.push({ label: title, view });
  if (view.page === "turn") {
    crumbs.push({ label: title, view: { page: "session", id: view.sessionId } });
    crumbs.push({ label: "Turn detail", view });
  }
  if (view.page === "cache" || view.page === "prompt") {
    crumbs.push({ label: title, view: { page: "session", id: view.sessionId } });
    crumbs.push({ label: view.page === "cache" ? "Cache detail" : "Prompt inspector", view });
  }
  if (view.page === "compare") crumbs.push({ label: "Compare", view });

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {crumbs.map((c, i) => (
        <span key={i} className="flex min-w-0 items-center gap-2">
          {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
          <button
            aria-current={i === crumbs.length - 1 ? "page" : undefined}
            className={cn(
              i === crumbs.length - 1
                ? "truncate text-foreground"
                : "truncate hover:text-foreground transition-colors"
            )}
            onClick={() => i < crumbs.length - 1 && onNavigate(c.view)}
          >
            {c.label}
          </button>
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
  const [railOpen, setRailOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const drawerDestination = useRef<"workspace" | "activity" | "dialog" | null>(null);
  const [omnibarOpen, setOmnibarOpen] = useState(false);
  const [liveTailOpen, setLiveTailOpen] = useState(false);
  const live = useLiveTail(true);
  const { data: collectorInfo } = useResource("collector-info", "initial", api.health);
  const { data: sessionList, loading: sessionsLoading, error: sessionsError, refresh: refreshSessions } = useResource("session-list", `${live.connections}:${live.receivedCount}`, api.sessions);
  const sessions = sessionList?.sessions ?? [];
  const liveButtonRef = useRef<HTMLButtonElement>(null);
  const sessionRevision = (id: string) => `${live.connections}:${live.activities.find(a => a.sessionId === id)?.revision ?? 0}`;
  // Ordered turn list kept warm for j/k navigation — populated whenever we're
  // anywhere inside a session (turn, cache, prompt pages).
  const [sessionTurns, setSessionTurns] = useState<TurnRecord[]>([]);
  // Stable refs so the keydown listener (registered once) reads fresh values.
  const viewRef = useRef<View>({ page: "sessions" });
  const sessionTurnsRef = useRef<TurnRecord[]>([]);
  const navigateRef = useRef<(v: View) => void>(() => {});
  const goPrefix = useRef(0);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 767px)");
    const onChange = () => { if (!mobile.matches) setRailOpen(false); };
    mobile.addEventListener("change", onChange);
    return () => mobile.removeEventListener("change", onChange);
  }, []);

  // Sync URL → view on browser back/forward
  useEffect(() => {
    const onPop = () => { setView(hashToView(window.location.hash)); setRailOpen(false); };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => { window.removeEventListener("popstate", onPop); window.removeEventListener("hashchange", onPop); };
  }, []);

  // Keep sessionTurns warm whenever we land on any session-scoped page
  useEffect(() => {
    const sid =
      view.page === "turn"    ? view.sessionId :
      view.page === "session" ? view.id :
      view.page === "cache"   ? view.sessionId :
      view.page === "prompt"  ? view.sessionId : null;
    let cancelled = false;
    setSessionTurns([]);
    sessionTurnsRef.current = [];
    if (sid) {
      api.turns(sid)
        .then((d) => {
          if (cancelled) return;
          setSessionTurns(d.turns);
          sessionTurnsRef.current = d.turns;
        })
        .catch(console.error);
    }
    viewRef.current = view;
    return () => { cancelled = true; };
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        drawerDestination.current = "dialog";
        setRailOpen(false);
        setOmnibarOpen(true);
        return;
      }
      // Plain-key navigation must not run while typing or inside a dialog.
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable || target?.closest('[role="dialog"], [data-background-controls]')) return;
      if (e.key === "Escape") { setOmnibarOpen(false); setRailOpen(false); setLiveTailOpen(false); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") { e.preventDefault(); setShortcutsOpen(true); return; }
      if (e.key === "/") { e.preventDefault(); document.querySelector<HTMLInputElement>('[aria-label="Filter loaded sessions"]')?.focus(); return; }
      if (e.key === "g") { goPrefix.current = Date.now(); return; }
      if (Date.now() - goPrefix.current < 800) {
        goPrefix.current = 0;
        if (e.key === "s") { e.preventDefault(); navigateRef.current({ page: "sessions" }); return; }
        if (e.key === "c") { e.preventDefault(); navigateRef.current({ page: "compare" }); return; }
      }
      if (e.key === "a") { e.preventDefault(); setLiveTailOpen(v => !v); return; }

      // j = next turn  /  k = prev turn
      if (e.key === "j" || e.key === "k") {
        const current = viewRef.current;
        if (current.page !== "turn") return;
        e.preventDefault();
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
    drawerDestination.current = "workspace";
    setLiveTailOpen(false);
    setRailOpen(false);
    window.history.pushState(null, "", viewToHash(next));
    setView(next);
    if (next.page === "sessions") {
      refreshSessions();
    }
  }

  // Keep ref in sync so the keydown closure (registered once) can call navigate
  navigateRef.current = navigate;

  const navItems = [
    { page: "sessions" as const, label: "Session review", icon: Layers },
    { page: "compare" as const, label: "Compare", icon: GitCompare },
  ];

  const railContent = <>
        <div className="workspace-brand"><span className="brand-mark"><SlidersHorizontal className="h-4 w-4" /></span><span>Agent Profiler</span></div>
        <button className="rail-link mb-4" aria-label="Search sessions and commands" onClick={() => { drawerDestination.current = "dialog"; setRailOpen(false); setOmnibarOpen(true); }}><Search className="h-4 w-4" />Search anything<kbd>⌘ K</kbd></button>
        <nav aria-label="Main navigation">
            {navItems.map(({ page, label, icon: Icon }) => (
              <button
                key={page}
                onClick={() => navigate({ page })}
                className="rail-link"
                aria-current={(page === "sessions" ? view.page !== "compare" : view.page === page) ? "page" : undefined}
              >
                <Icon className="h-4 w-4" />
                {label}
                <kbd>{page === "sessions" ? "G S" : "G C"}</kbd>
              </button>
            ))}
        </nav>
        <button className="rail-link" aria-pressed={liveTailOpen} onClick={() => { drawerDestination.current = "activity"; setLiveTailOpen(v => !v); setRailOpen(false); }}><Radio className="h-4 w-4" />Activity<kbd>A</kbd></button>
        <p className="rail-label">Recent sessions</p>
        <div className="rail-recent">
          {sessions.slice(0, 7).map(s => <a key={s.id} href={viewToHash({ page: "session", id: s.id })} className="rail-link" title={s.title || s.id} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate({ page: "session", id: s.id }); }}><Circle className="h-3 w-3 shrink-0" /><span className="truncate">{s.title || "Untitled session"}</span></a>)}
          {!sessions.length && <p className="px-2 text-xs text-muted-foreground">Your sessions will appear here.</p>}
        </div>
        <div className="mt-5 border-t border-border pt-3">
          <button className="rail-link" onClick={() => { drawerDestination.current = "dialog"; setRailOpen(false); setShortcutsOpen(true); }}><Keyboard className="h-4 w-4" />Keyboard shortcuts<kbd>?</kbd></button>
          <p className="mt-3 flex items-center gap-2 px-2 text-xs text-muted-foreground"><span className={cn("h-1.5 w-1.5 rounded-full", live.connection === "connected" ? "bg-green" : "bg-amber")} />{{ connected: "Collector connected", connecting: "Connecting…", reconnecting: "Reconnecting…", disconnected: "Disconnected" }[live.connection]}</p>
          <p className="mt-1 px-2 text-[11px] text-muted-foreground">Local workspace · Data stays here</p>
        </div>
      </>;

  return (
    <div className="app-shell">
      <a href="#workspace" onClick={event => { event.preventDefault(); document.querySelector<HTMLElement>("main")?.focus(); }} className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:bg-popover focus:p-3">Skip to workspace</a>
      <aside className="workspace-rail" aria-label="Workspace navigation">{railContent}</aside>
      <div className="workspace-frame">
      <header className="workspace-bar">
        <div className="flex min-w-0 items-center gap-3">
          <Dialog open={railOpen} onOpenChange={open => { if (open) drawerDestination.current = null; setRailOpen(open); }}>
            <DialogTrigger asChild><Button ref={mobileMenuRef} variant="ghost" size="icon" className="mobile-menu-button" aria-label="Open navigation"><Menu className="h-4 w-4" /></Button></DialogTrigger>
            <DialogContent aria-modal="true" className="left-0 top-0 flex h-dvh max-h-none w-[min(300px,85vw)] max-w-none translate-x-0 flex-col rounded-none border-0 border-r border-border bg-rail px-3 pb-3 pt-5"
              onCloseAutoFocus={event => {
                event.preventDefault();
                const destination = drawerDestination.current;
                drawerDestination.current = null;
                if (destination === "dialog") return;
                requestAnimationFrame(() => {
                  if (destination === "workspace" || !window.matchMedia("(max-width: 767px)").matches) document.querySelector<HTMLElement>("main")?.focus();
                  else if (destination === "activity") (document.querySelector<HTMLElement>("#session-activity") ?? document.querySelector<HTMLElement>("main"))?.focus();
                  else mobileMenuRef.current?.focus();
                });
              }}>
              <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
              <DialogDescription className="sr-only">Choose a view or recent session. Escape closes navigation.</DialogDescription>
              {railContent}
            </DialogContent>
          </Dialog>
          <Breadcrumb view={view} sessions={sessions} onNavigate={navigate} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AnimalBackground />
          <Button
            ref={liveButtonRef}
            variant="ghost"
            size="sm"
            aria-label={liveTailOpen ? "Hide session activity" : "Show session activity"}
            aria-expanded={liveTailOpen}
            aria-controls="session-activity"
            onClick={() => setLiveTailOpen((v) => !v)}
            className={cn(
              "gap-1.5 text-xs",
              liveTailOpen && "border border-border text-foreground"
            )}
          >
            <Radio className="h-3.5 w-3.5" /><span className="hidden sm:inline">Activity</span>
          </Button>
          <Button variant="ghost" size="sm" aria-label="Search sessions and commands" onClick={() => setOmnibarOpen(true)} className="gap-1.5 text-xs text-muted-foreground">
            <Search className="h-3.5 w-3.5" /><kbd className="hidden sm:inline">⌘ K</kbd>
          </Button>
        </div>
      </header>
      {collectorInfo?.demo && <p role="status" className="flex flex-wrap items-center gap-x-2 border-b border-border bg-card px-7 py-2 text-xs text-secondary-foreground"><span className="font-medium text-primary">Demo workspace</span> Synthetic data · Your captured sessions are unchanged.</p>}

      {/* Main layout */}
      <div className="workspace-body" data-activity={liveTailOpen}>
        {/* Content */}
        <main id="workspace" tabIndex={-1} aria-label="Profiler workspace" className="workspace-main">

          {view.page === "sessions" && (
            <SessionsView sessions={sessions} loading={sessionsLoading} error={sessionsError} onRetry={refreshSessions} onSelect={(id) => navigate({ page: "session", id })} />
          )}
          {view.page === "session" && (
            <SessionDetailView
              sessionId={view.id}
              refreshKey={sessionRevision(view.id)}
              onTurnSelect={(id) => navigate({ page: "turn", id, sessionId: view.id })}
              onCacheView={() => navigate({ page: "cache", sessionId: view.id })}
              onPromptView={llmCallId => navigate({ page: "prompt", llmCallId, sessionId: view.id })}
            />
          )}
          {view.page === "turn" && (
            <TurnDetailView
              turnId={view.id}
              sessionId={view.sessionId}
              refreshKey={sessionRevision(view.sessionId)}
              allTurns={sessionTurns}
              onPromptView={(llmCallId) =>
                navigate({ page: "prompt", llmCallId, sessionId: view.sessionId })
              }
            />
          )}
          {view.page === "cache" && <CachePanelView sessionId={view.sessionId} refreshKey={sessionRevision(view.sessionId)} onTurnSelect={id => navigate({ page: "turn", id, sessionId: view.sessionId })} />}
          {view.page === "prompt" && (
            <PromptInspectorView llmCallId={view.llmCallId} sessionId={view.sessionId} />
          )}
          {view.page === "compare" && <CompareView />}
        </main>

        {/* Live tail — separate panel, not persistent sidebar */}
        {liveTailOpen && (
          <aside className="activity-panel">
            <LiveActivity live={live} onClose={() => { setLiveTailOpen(false); liveButtonRef.current?.focus(); }} onOpenSession={id => { navigate({ page: "session", id }); setLiveTailOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>("main")?.focus()); }} />
          </aside>
        )}
      </div>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle className="text-base font-semibold">Move without the mouse</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">Shortcuts are inactive while typing, except command search.</DialogDescription>
          <dl className="shortcut-list mt-4 text-[13px]">
            <dt>Search sessions & commands</dt><dd><kbd>⌘ / Ctrl K</kbd></dd>
            <dt>Go to session review</dt><dd><kbd>G</kbd> <kbd>S</kbd></dd>
            <dt>Go to compare</dt><dd><kbd>G</kbd> <kbd>C</kbd></dd>
            <dt>Toggle activity</dt><dd><kbd>A</kbd></dd>
            <dt>Filter sessions</dt><dd><kbd>/</kbd></dd>
            <dt>Next / previous session or turn</dt><dd><kbd>J</kbd> <kbd>K</kbd></dd>
            <dt>Open selected session</dt><dd><kbd>Enter</kbd></dd>
            <dt>Show keyboard shortcuts</dt><dd><kbd>?</kbd></dd>
          </dl>
        </DialogContent>
      </Dialog>

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
