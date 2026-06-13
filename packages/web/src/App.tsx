import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  CompareResult,
  Insight,
  LlmCallRecord,
  PromptSegmentRecord,
  SessionRecord,
  ToolCallRecord,
  TurnRecord,
} from "./types";
import { useLiveTail } from "./useLiveTail";

// ── Utility ───────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

// ── Badge ─────────────────────────────────────────────────────────────────────

function Badge({
  label,
  variant = "neutral",
}: {
  label: string;
  variant?: "neutral" | "warn" | "critical" | "ok" | "muted";
}) {
  const colors: Record<string, string> = {
    neutral: "var(--badge-neutral)",
    warn: "var(--badge-warn)",
    critical: "var(--badge-critical)",
    ok: "var(--badge-ok)",
    muted: "var(--badge-muted)",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 99,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        background: colors[variant],
        color: "rgba(255,255,255,0.9)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ── InsightCard ───────────────────────────────────────────────────────────────

function InsightCard({ insight }: { insight: Insight }) {
  const variant =
    insight.severity === "critical"
      ? "critical"
      : insight.severity === "warn"
        ? "warn"
        : "neutral";
  return (
    <div className="insight-card" data-severity={insight.severity}>
      <div className="insight-header">
        <Badge label={insight.severity.toUpperCase()} variant={variant} />
        <span className="insight-kind">{insight.kind}</span>
        <span className="insight-title">{insight.title}</span>
      </div>
      <p className="insight-summary">{insight.summary}</p>
    </div>
  );
}

// ── Waterfall bar ─────────────────────────────────────────────────────────────

function WaterfallBar({
  label,
  latencyMs,
  maxMs,
  color,
}: {
  label: string;
  latencyMs: number;
  maxMs: number;
  color: string;
}) {
  const pct = maxMs > 0 ? Math.max(2, (latencyMs / maxMs) * 100) : 2;
  return (
    <div className="waterfall-row">
      <span className="waterfall-label" title={label}>
        {label}
      </span>
      <div className="waterfall-track">
        <div
          className="waterfall-bar"
          style={{ width: `${pct}%`, background: color }}
          title={fmtMs(latencyMs)}
        />
      </div>
      <span className="waterfall-val">{fmtMs(latencyMs)}</span>
    </div>
  );
}

// ── Treemap segment (for prompt composition) ──────────────────────────────────

const SEGMENT_COLORS: Record<string, string> = {
  system: "#3b82f6",
  tool: "#f59e0b",
  mcp: "#8b5cf6",
  skill: "#10b981",
  user: "#6b7280",
  assistant: "#6366f1",
  instructions: "#3b82f6",
};

function segColor(sourceKind: string): string {
  return SEGMENT_COLORS[sourceKind] ?? "#4b5563";
}

// ── Views ─────────────────────────────────────────────────────────────────────

type View =
  | { page: "sessions" }
  | { page: "session"; id: string }
  | { page: "turn"; id: string; sessionId: string }
  | { page: "cache"; sessionId: string }
  | { page: "prompt"; llmCallId: string; sessionId: string }
  | { page: "rightsizing" }
  | { page: "compare" };

// ── Sessions Explorer ─────────────────────────────────────────────────────────

function SessionsView({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<keyof SessionRecord>("startedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setLoading(true);
    api
      .sessions()
      .then((d) => setSessions(d.sessions))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const sorted = useMemo(() => {
    const filtered = filter
      ? sessions.filter(
          (s) =>
            s.id.includes(filter) ||
            s.agent?.includes(filter) ||
            s.model?.includes(filter) ||
            s.harness.includes(filter)
        )
      : sessions;

    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [sessions, filter, sortKey, sortDir]);

  function toggleSort(key: keyof SessionRecord) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const cols: { key: keyof SessionRecord; label: string; render: (s: SessionRecord) => React.ReactNode }[] = [
    { key: "startedAt", label: "Started", render: (s) => ago(s.startedAt) },
    { key: "harness", label: "Harness", render: (s) => <Badge label={s.harness} variant="neutral" /> },
    { key: "agent", label: "Agent", render: (s) => s.agent ?? "—" },
    { key: "model", label: "Model", render: (s) => s.model ?? "—" },
    { key: "turnCount", label: "Turns", render: (s) => fmt(s.turnCount) },
    { key: "promptTokens", label: "Prompt tok", render: (s) => fmt(s.promptTokens) },
    { key: "cacheReadTokens", label: "Cache hit", render: (s) => <span style={{ color: cacheRatio(s) > 0.5 ? "var(--green)" : "var(--amber)" }}>{fmtRatio(cacheRatio(s))}</span> },
    { key: "costTotal", label: "Cost", render: (s) => fmtCost(s.costTotal) },
  ];

  return (
    <div className="view">
      <div className="view-header">
        <h2>Sessions</h2>
        <input
          className="filter-input"
          placeholder="Filter by id, agent, model, harness..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.key} onClick={() => toggleSort(c.key)} className="sortable">
                    {c.label} {sortKey === c.key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id} onClick={() => onSelect(s.id)} className="clickable">
                  {cols.map((c) => <td key={c.key}>{c.render(s)}</td>)}
                </tr>
              ))}
              {!sorted.length && (
                <tr>
                  <td colSpan={cols.length} className="muted center">
                    No sessions yet. Point opencode-openinference at this server's OTLP endpoint.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
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

  if (!session) return <p className="muted">Loading…</p>;

  const hitRatio = cacheRatio(session);

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h2 style={{ marginBottom: 4 }}>Session</h2>
          <code className="id-chip">{session.id}</code>
        </div>
        <div className="btn-row">
          <button className="ghost" onClick={onCacheView}>Cache panel</button>
          <button className="ghost" onClick={runProfile} disabled={profiling}>
            {profiling ? "Profiling…" : "Run profilers"}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="stats-strip">
        <StatBox label="Turns" value={fmt(session.turnCount)} />
        <StatBox label="LLM calls" value={fmt(session.llmCallCount)} />
        <StatBox label="Tool calls" value={fmt(session.toolCallCount)} />
        <StatBox label="Prompt tok" value={fmt(session.promptTokens)} />
        <StatBox label="Completion tok" value={fmt(session.completionTokens)} />
        <StatBox label="Cache hit" value={fmtRatio(hitRatio)} highlight={hitRatio < 0.3 ? "warn" : "ok"} />
        <StatBox label="Cost" value={fmtCost(session.costTotal)} />
        <StatBox label="Harness" value={session.harness} />
        {session.model && <StatBox label="Model" value={session.model} />}
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <section className="section">
          <h3>Insights</h3>
          <div className="insight-list">
            {insights.map((ins) => (
              <InsightCard key={ins.id} insight={ins} />
            ))}
          </div>
        </section>
      )}

      {/* Turns table */}
      <section className="section">
        <h3>Turns ({turns.length})</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>User message</th>
                <th>LLM calls</th>
                <th>Prompt tok</th>
                <th>Cache hit</th>
                <th>Cost</th>
                <th>Signal</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((t) => {
                const turnCacheRatio = (t.promptTokens > 0) ? t.cacheReadTokens / t.promptTokens : 0;
                return (
                  <tr key={t.id} onClick={() => onTurnSelect(t.id)} className="clickable">
                    <td>{t.idx + 1}</td>
                    <td className="truncate" style={{ maxWidth: 280 }}>
                      {t.userText?.slice(0, 80) ?? "—"}
                    </td>
                    <td>{t.llmRoundTrips}</td>
                    <td>{fmt(t.promptTokens)}</td>
                    <td>
                      <span style={{ color: turnCacheRatio > 0.5 ? "var(--green)" : "var(--amber)" }}>
                        {fmtRatio(turnCacheRatio)}
                      </span>
                    </td>
                    <td>{fmtCost(t.cost)}</td>
                    <td>
                      {t.endSignal === "error" ? (
                        <Badge label="error" variant="critical" />
                      ) : t.endSignal === "user_stopped" ? (
                        <Badge label="stopped" variant="warn" />
                      ) : (
                        <Badge label="ok" variant="ok" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatBox({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "warn" | "ok";
}) {
  return (
    <div className="stat-box">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value"
        style={{
          color:
            highlight === "warn"
              ? "var(--amber)"
              : highlight === "ok"
                ? "var(--green)"
                : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Turn Detail / Waterfall ───────────────────────────────────────────────────

function TurnDetailView({
  turnId,
  sessionId,
  onPromptView,
}: {
  turnId: string;
  sessionId: string;
  onPromptView: (llmCallId: string) => void;
}) {
  const [turn, setTurn] = useState<TurnRecord | null>(null);
  const [llmCalls, setLlmCalls] = useState<LlmCallRecord[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([]);
  const [expandedBlob, setExpandedBlob] = useState<string | null>(null);
  const [blobCache, setBlobCache] = useState<Record<string, string>>({});

  useEffect(() => {
    api.turns(sessionId).then((d) => {
      const t = d.turns.find((x) => x.id === turnId);
      if (t) setTurn(t);
    });
    api.llmCalls(turnId).then((d) => setLlmCalls(d.llmCalls));
    api.toolCalls(turnId).then((d) => setToolCalls(d.toolCalls));
  }, [turnId, sessionId]);

  async function showBlob(ref: string) {
    if (expandedBlob === ref) {
      setExpandedBlob(null);
      return;
    }
    if (!blobCache[ref]) {
      const text = await api.blob(ref);
      setBlobCache((c) => ({ ...c, [ref]: text }));
    }
    setExpandedBlob(ref);
  }

  if (!turn) return <p className="muted">Loading…</p>;

  const allItems: Array<{ type: "llm" | "tool"; id: string; name: string; latencyMs: number; color: string }> = [
    ...llmCalls.map((c) => ({ type: "llm" as const, id: c.id, name: c.model, latencyMs: c.latencyMs, color: "#6366f1" })),
    ...toolCalls.map((c) => ({ type: "tool" as const, id: c.id, name: c.name, latencyMs: c.latencyMs, color: kindColor(c.kind) })),
  ];
  const maxMs = allItems.reduce((m, x) => Math.max(m, x.latencyMs), 1);

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h2>Turn {turn.idx + 1}</h2>
          <code className="id-chip">{turn.id}</code>
        </div>
      </div>

      <div className="stats-strip">
        <StatBox label="LLM calls" value={fmt(turn.llmRoundTrips)} />
        <StatBox label="Prompt tok" value={fmt(turn.promptTokens)} />
        <StatBox label="Completion tok" value={fmt(turn.completionTokens)} />
        <StatBox label="Cache hit" value={fmtRatio(turn.promptTokens > 0 ? turn.cacheReadTokens / turn.promptTokens : 0)} />
        <StatBox label="Cost" value={fmtCost(turn.cost)} />
      </div>

      {turn.userText && (
        <section className="section">
          <h3>User message</h3>
          <pre className="body-pre">{turn.userText}</pre>
        </section>
      )}

      {turn.assistantText && (
        <section className="section">
          <h3>Assistant response</h3>
          <pre className="body-pre">{turn.assistantText.slice(0, 2000)}{turn.assistantText.length > 2000 ? "\n…(truncated)" : ""}</pre>
        </section>
      )}

      {/* Waterfall */}
      {allItems.length > 0 && (
        <section className="section">
          <h3>Span waterfall</h3>
          <div className="waterfall">
            {allItems.map((item) => (
              <WaterfallBar
                key={item.id}
                label={item.name}
                latencyMs={item.latencyMs}
                maxMs={maxMs}
                color={item.color}
              />
            ))}
          </div>
        </section>
      )}

      {/* LLM calls */}
      {llmCalls.length > 0 && (
        <section className="section">
          <h3>LLM calls ({llmCalls.length})</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Latency</th>
                  <th>Prompt tok</th>
                  <th>Completion tok</th>
                  <th>Cache read</th>
                  <th>Cost</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {llmCalls.map((c) => (
                  <tr key={c.id}>
                    <td>{c.model}</td>
                    <td>{fmtMs(c.latencyMs)}</td>
                    <td>{fmt(c.promptTokens)}</td>
                    <td>{fmt(c.completionTokens)}</td>
                    <td>{fmt(c.cacheReadTokens)}</td>
                    <td>{fmtCost(c.cost)}</td>
                    <td>
                      <button className="ghost small" onClick={() => onPromptView(c.id)}>
                        Prompt inspector
                      </button>
                      {c.inputMessagesRef && (
                        <button
                          className="ghost small"
                          style={{ marginLeft: 4 }}
                          onClick={() => showBlob(c.inputMessagesRef!)}
                        >
                          {expandedBlob === c.inputMessagesRef ? "Hide" : "Messages"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {expandedBlob && blobCache[expandedBlob] && (
            <pre className="body-pre" style={{ marginTop: 8 }}>
              {blobCache[expandedBlob]}
            </pre>
          )}
        </section>
      )}

      {/* Tool calls */}
      {toolCalls.length > 0 && (
        <section className="section">
          <h3>Tool calls ({toolCalls.length})</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Server/Skill</th>
                  <th>Latency</th>
                  <th>Output tok est</th>
                  <th>Status</th>
                  <th>Args/Output</th>
                </tr>
              </thead>
              <tbody>
                {toolCalls.map((tc) => (
                  <tr key={tc.id}>
                    <td>{tc.name}</td>
                    <td><Badge label={tc.kind} variant="neutral" /></td>
                    <td>{tc.server ?? tc.skill ?? "—"}</td>
                    <td>{fmtMs(tc.latencyMs)}</td>
                    <td>{fmt(tc.tokensOutEst)}</td>
                    <td>{tc.status ?? "—"}</td>
                    <td>
                      {tc.argsRef && (
                        <button className="ghost small" onClick={() => showBlob(tc.argsRef!)}>
                          {expandedBlob === tc.argsRef ? "Hide" : "Args"}
                        </button>
                      )}
                      {tc.outputRef && (
                        <button
                          className="ghost small"
                          style={{ marginLeft: 4 }}
                          onClick={() => showBlob(tc.outputRef!)}
                        >
                          {expandedBlob === tc.outputRef ? "Hide" : "Output"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {expandedBlob && blobCache[expandedBlob] && (
            <pre className="body-pre" style={{ marginTop: 8 }}>
              {blobCache[expandedBlob]}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}

function kindColor(kind: string): string {
  const m: Record<string, string> = { mcp: "#8b5cf6", skill: "#10b981", builtin: "#f59e0b" };
  return m[kind] ?? "#4b5563";
}

// ── Cache Panel ───────────────────────────────────────────────────────────────

function CachePanelView({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [session, setSession] = useState<SessionRecord | null>(null);

  useEffect(() => {
    api.session(sessionId).then((d) => setSession(d.session));
    api.turns(sessionId).then((d) => setTurns(d.turns));
  }, [sessionId]);

  if (!session) return <p className="muted">Loading…</p>;

  const sessionHitRatio = cacheRatio(session);

  // Per-turn hit ratio series
  const turnSeries = turns.map((t) => ({
    idx: t.idx + 1,
    ratio: t.promptTokens > 0 ? t.cacheReadTokens / t.promptTokens : 0,
    cacheRead: t.cacheReadTokens,
    cacheWrite: t.cacheWriteTokens,
    prompt: t.promptTokens,
  }));

  const maxTokens = Math.max(...turnSeries.map((t) => t.prompt), 1);

  return (
    <div className="view">
      <div className="view-header">
        <h2>Cache Panel</h2>
        <span className="muted">Session: {sessionId.slice(0, 16)}…</span>
      </div>

      <div className="stats-strip">
        <StatBox label="Overall hit ratio" value={fmtRatio(sessionHitRatio)} highlight={sessionHitRatio > 0.5 ? "ok" : "warn"} />
        <StatBox label="Total cache-read tok" value={fmt(session.cacheReadTokens)} />
        <StatBox label="Total cache-write tok" value={fmt(session.cacheWriteTokens)} />
        <StatBox label="Total prompt tok" value={fmt(session.promptTokens)} />
      </div>

      {/* Bar chart: cache hit ratio per turn */}
      <section className="section">
        <h3>Cache hit ratio per turn</h3>
        <div className="cache-chart">
          {turnSeries.map((t) => (
            <div key={t.idx} className="cache-bar-col">
              <div className="cache-bar-wrap">
                {/* stacked bar: cache_read / prompt */}
                <div
                  className="cache-bar-total"
                  style={{ height: `${Math.max(4, (t.prompt / maxTokens) * 100)}%` }}
                  title={`Prompt: ${fmt(t.prompt)} tok`}
                >
                  <div
                    className="cache-bar-read"
                    style={{ height: `${t.ratio * 100}%` }}
                    title={`Cache read: ${fmt(t.cacheRead)} tok (${fmtRatio(t.ratio)})`}
                  />
                </div>
              </div>
              <span className="cache-bar-label">{t.idx}</span>
            </div>
          ))}
        </div>
        <div className="cache-legend">
          <span style={{ color: "var(--green)" }}>■ Cache read</span>
          <span style={{ color: "var(--muted-color)", marginLeft: 12 }}>■ Prompt total</span>
        </div>
      </section>

      <section className="section">
        <h3>Turn breakdown</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Prompt tok</th>
                <th>Cache read</th>
                <th>Cache write</th>
                <th>Hit ratio</th>
              </tr>
            </thead>
            <tbody>
              {turnSeries.map((t) => (
                <tr key={t.idx}>
                  <td>{t.idx}</td>
                  <td>{fmt(t.prompt)}</td>
                  <td>{fmt(t.cacheRead)}</td>
                  <td>{fmt(t.cacheWrite)}</td>
                  <td>
                    <span style={{ color: t.ratio > 0.5 ? "var(--green)" : "var(--amber)" }}>
                      {fmtRatio(t.ratio)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ── System Prompt Inspector ───────────────────────────────────────────────────

function PromptInspectorView({
  llmCallId,
  sessionId,
}: {
  llmCallId: string;
  sessionId: string;
}) {
  const [segments, setSegments] = useState<PromptSegmentRecord[]>([]);
  const [messages, setMessages] = useState<string | null>(null);
  const [llmCall, setLlmCall] = useState<LlmCallRecord | null>(null);

  useEffect(() => {
    api.segments(llmCallId).then((d) => setSegments(d.segments));
    // fetch llm call to get the inputMessagesRef
    api.llmCalls(sessionId).then((d) => {
      const c = d.llmCalls.find((x) => x.id === llmCallId);
      if (c) {
        setLlmCall(c);
        if (c.inputMessagesRef) {
          api.blob(c.inputMessagesRef).then(setMessages);
        }
      }
    });
  }, [llmCallId, sessionId]);

  const totalTokens = segments.reduce((s, x) => s + x.tokenEst, 0);
  const totalChars = segments.reduce((s, x) => s + x.charLen, 0);

  return (
    <div className="view">
      <div className="view-header">
        <h2>System Prompt Inspector</h2>
        <code className="id-chip">{llmCallId}</code>
      </div>

      {llmCall && (
        <div className="stats-strip">
          <StatBox label="Model" value={llmCall.model} />
          <StatBox label="Prompt tok" value={fmt(llmCall.promptTokens)} />
          <StatBox label="Cache read tok" value={fmt(llmCall.cacheReadTokens)} />
          <StatBox label="Segments" value={fmt(segments.length)} />
          <StatBox label="Est. segment tok" value={fmt(totalTokens)} />
        </div>
      )}

      {segments.length > 0 && (
        <section className="section">
          <h3>Prompt composition</h3>
          {/* Treemap (simplified proportional strip) */}
          <div className="treemap-strip">
            {segments.map((seg, i) => {
              const pct = totalChars > 0 ? (seg.charLen / totalChars) * 100 : 0;
              return (
                <div
                  key={i}
                  className="treemap-block"
                  style={{ width: `${Math.max(0.5, pct)}%`, background: segColor(seg.sourceKind) }}
                  title={`${seg.sourceName} (${seg.sourceKind}): ${fmt(seg.charLen)} chars, ~${fmt(seg.tokenEst)} tokens`}
                />
              );
            })}
          </div>
          {/* Legend */}
          <div className="treemap-legend">
            {segments.map((seg, i) => (
              <span key={i} className="legend-item">
                <span style={{ color: segColor(seg.sourceKind) }}>■</span>{" "}
                {seg.sourceName}{" "}
                <span className="muted">~{fmt(seg.tokenEst)} tok</span>
                {!seg.isStatic && <Badge label="volatile" variant="muted" />}
              </span>
            ))}
          </div>

          {/* Segment detail table */}
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Kind</th>
                  <th>Name</th>
                  <th>Chars</th>
                  <th>~Tokens</th>
                  <th>Static?</th>
                  <th>SHA256</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((seg, i) => (
                  <tr key={i}>
                    <td>{seg.ord}</td>
                    <td><span style={{ color: segColor(seg.sourceKind) }}>{seg.sourceKind}</span></td>
                    <td>{seg.sourceName}</td>
                    <td>{fmt(seg.charLen)}</td>
                    <td>{fmt(seg.tokenEst)}</td>
                    <td>{seg.isStatic ? "✓" : "—"}</td>
                    <td><code style={{ fontSize: 11 }}>{seg.sha256.slice(0, 12)}…</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {segments.length === 0 && messages && (
        <section className="section">
          <p className="muted">
            No segment data available — enriched capture (§4.1) is not active. Showing raw messages:
          </p>
          <pre className="body-pre">{messages.slice(0, 4000)}</pre>
        </section>
      )}

      {!segments.length && !messages && (
        <p className="muted">No prompt data available for this LLM call.</p>
      )}
    </div>
  );
}

// ── Compare View ──────────────────────────────────────────────────────────────

function CompareView() {
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.compare().then((d) => setResult(d.compare)).catch(console.error).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="muted">Loading…</p>;
  if (!result || !result.metrics.length) {
    return (
      <div className="view">
        <h2>Cross-Harness Compare</h2>
        <p className="muted">No data. Ingest traces from multiple harnesses first.</p>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header">
        <h2>Cross-Harness Compare</h2>
        <span className="muted">Bootstrap 95% CIs</span>
      </div>

      <section className="section">
        <h3>Per-harness metrics</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Harness</th>
                <th>Sessions</th>
                <th>Turns/session</th>
                <th>Cache hit %</th>
                <th>Tokens/turn</th>
                <th>Cost/turn</th>
                <th>Latency/turn</th>
              </tr>
            </thead>
            <tbody>
              {result.metrics.map((m) => (
                <tr key={m.harness}>
                  <td><Badge label={m.harness} variant="neutral" /></td>
                  <td>{fmt(m.sessionCount)}</td>
                  <td>{fmt(m.meanTurnsPerSession, 1)}</td>
                  <td>{fmtRatio(m.meanCacheHitRatio)}</td>
                  <td>{fmt(m.meanTokensPerTurn, 0)}</td>
                  <td>{fmtCost(m.meanCostPerTurn)}</td>
                  <td>{fmtMs(m.meanLatencyMsPerTurn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {result.pairwiseDeltas.length > 0 && (
        <section className="section">
          <h3>Pairwise deltas</h3>
          {result.pairwiseDeltas.map((d) => (
            <div key={`${d.from}-${d.to}`} className="compare-pair">
              <div className="compare-pair-header">
                <Badge label={d.from} variant="neutral" />
                <span className="muted" style={{ margin: "0 6px" }}>vs</span>
                <Badge label={d.to} variant="neutral" />
              </div>
              <div className="delta-grid">
                <DeltaCard
                  label="Cost/turn"
                  delta={d.costPerTurnDelta.delta}
                  ciLow={d.costPerTurnDelta.ciLow}
                  ciHigh={d.costPerTurnDelta.ciHigh}
                  format={fmtCost}
                  lowerIsBetter
                />
                <DeltaCard
                  label="Tokens/turn"
                  delta={d.tokensPerTurnDelta.delta}
                  ciLow={d.tokensPerTurnDelta.ciLow}
                  ciHigh={d.tokensPerTurnDelta.ciHigh}
                  format={(v) => fmt(v, 0)}
                  lowerIsBetter
                />
                <DeltaCard
                  label="Cache hit %"
                  delta={d.cacheHitRatioDelta.delta}
                  ciLow={d.cacheHitRatioDelta.ciLow}
                  ciHigh={d.cacheHitRatioDelta.ciHigh}
                  format={fmtRatio}
                  lowerIsBetter={false}
                />
              </div>
            </div>
          ))}
        </section>
      )}

      {result.insights.length > 0 && (
        <section className="section">
          <h3>Insights</h3>
          <div className="insight-list">
            {result.insights.map((ins) => (
              <InsightCard key={ins.id} insight={ins} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DeltaCard({
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
  const color = isImprovement ? "var(--green)" : delta === 0 ? "inherit" : "var(--amber)";
  return (
    <div className="delta-card">
      <div className="delta-label">{label}</div>
      <div className="delta-value" style={{ color }}>
        {delta >= 0 ? "+" : ""}{format(delta)}
      </div>
      <div className="delta-ci muted">
        95% CI [{format(ciLow)}, {format(ciHigh)}]
      </div>
    </div>
  );
}

// ── Live Tail ─────────────────────────────────────────────────────────────────

function LiveTailPanel({ enabled }: { enabled: boolean }) {
  const events = useLiveTail(enabled);
  if (!enabled) return null;
  return (
    <div className="live-tail">
      <div className="live-tail-header">
        <span className="live-dot" />
        Live tail
      </div>
      <div className="live-tail-events">
        {events.length === 0 && <p className="muted">Waiting for events…</p>}
        {events.map((e, i) => (
          <div key={i} className="live-event">
            <Badge label={e.type} variant="neutral" />
            <code className="live-event-id">
              {(e.data as Record<string, unknown>).id
                ? String((e.data as Record<string, unknown>).id).slice(0, 20)
                : "—"}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Omnibar ───────────────────────────────────────────────────────────────────

const STATIC_COMMANDS = [
  { label: "Go to Sessions", action: "sessions" },
  { label: "Cross-Harness Compare", action: "compare" },
  { label: "Toggle live tail", action: "live-tail" },
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
      .filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          (s.agent ?? "").toLowerCase().includes(q) ||
          (s.model ?? "").toLowerCase().includes(q)
      )
      .slice(0, 8)
      .map((s) => ({
        label: `Session: ${s.agent ?? s.id.slice(0, 8)} — ${s.model ?? "?"}`,
        action: `session:${s.id}`,
      }));
    return [...cmds, ...sess];
  }, [query, sessions]);

  if (!open) return null;

  function select(action: string) {
    if (action === "sessions") onNavigate({ page: "sessions" });
    else if (action === "compare") onNavigate({ page: "compare" });
    else if (action === "live-tail") onLiveTail();
    else if (action.startsWith("session:")) onNavigate({ page: "session", id: action.slice(8) });
    onClose();
  }

  return (
    <div className="omnibar-backdrop" onClick={onClose}>
      <div className="omnibar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Search sessions, commands…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && items[0]) select(items[0].action);
            if (e.key === "Escape") onClose();
          }}
        />
        <ul>
          {items.map((item) => (
            <li key={item.action} onClick={() => select(item.action)}>
              {item.label}
            </li>
          ))}
          {!items.length && <li className="muted">No results</li>}
        </ul>
      </div>
    </div>
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
    if (prev) crumbs.push({ label: `Session`, view: prev });
    crumbs.push({ label: "Turn " + view.id.slice(0, 8), view });
  }
  if (view.page === "cache") crumbs.push({ label: "Cache", view });
  if (view.page === "prompt") crumbs.push({ label: "Prompt Inspector", view });
  if (view.page === "compare") crumbs.push({ label: "Compare", view });
  if (view.page === "rightsizing") crumbs.push({ label: "Right-sizing", view });

  return (
    <nav className="breadcrumb">
      {crumbs.map((c, i) => (
        <span key={i}>
          {i > 0 && <span className="bc-sep">›</span>}
          <span
            className={`bc-item${i === crumbs.length - 1 ? " bc-active" : " bc-link"}`}
            onClick={() => i < crumbs.length - 1 && onNavigate(c.view)}
          >
            {c.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

export function App() {
  const [view, setView] = useState<View>({ page: "sessions" });
  const [history, setHistory] = useState<View[]>([]);
  const [omnibarOpen, setOmnibarOpen] = useState(false);
  const [liveTailEnabled, setLiveTailEnabled] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);

  useEffect(() => {
    api.sessions().then((d) => setSessions(d.sessions)).catch(console.error);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOmnibarOpen((v) => !v);
      }
      if (e.key === "Escape") setOmnibarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function navigate(next: View) {
    setHistory((h) => [...h, view]);
    setView(next);
    setSessions((prev) => {
      if (next.page === "sessions") {
        // refresh
        api.sessions().then((d) => setSessions(d.sessions)).catch(console.error);
      }
      return prev;
    });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="eyebrow">agent-profiler</div>
          <nav className="nav-pills">
            {(["sessions", "compare"] as const).map((page) => (
              <button
                key={page}
                className={`nav-pill${view.page === page ? " active" : ""}`}
                onClick={() => navigate({ page })}
              >
                {page === "sessions" ? "Sessions" : "Compare"}
              </button>
            ))}
          </nav>
        </div>
        <div className="topbar-right">
          <button
            className={`ghost${liveTailEnabled ? " active-btn" : ""}`}
            onClick={() => setLiveTailEnabled((v) => !v)}
            title="Toggle live tail"
          >
            {liveTailEnabled ? "● Live" : "Live tail"}
          </button>
          <button className="ghost" onClick={() => setOmnibarOpen(true)}>
            ⌘K
          </button>
        </div>
      </header>

      <div className="main-layout">
        <div className="content-area">
          <Breadcrumb view={view} history={history} onNavigate={navigate} />

          {view.page === "sessions" && (
            <SessionsView onSelect={(id) => navigate({ page: "session", id })} />
          )}
          {view.page === "session" && (
            <SessionDetailView
              sessionId={view.id}
              onTurnSelect={(id) =>
                navigate({ page: "turn", id, sessionId: view.id })
              }
              onCacheView={() => navigate({ page: "cache", sessionId: view.id })}
            />
          )}
          {view.page === "turn" && (
            <TurnDetailView
              turnId={view.id}
              sessionId={view.sessionId}
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
        </div>

        {liveTailEnabled && (
          <aside className="live-tail-aside">
            <LiveTailPanel enabled={liveTailEnabled} />
          </aside>
        )}
      </div>

      <Omnibar
        open={omnibarOpen}
        onClose={() => setOmnibarOpen(false)}
        onNavigate={navigate}
        sessions={sessions}
        onLiveTail={() => setLiveTailEnabled((v) => !v)}
      />
    </div>
  );
}
