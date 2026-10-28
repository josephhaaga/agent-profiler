import { useEffect, useRef, useState } from "react";
import { ChevronRight, Pause, Play, RefreshCw, X } from "lucide-react";
import { api } from "./api";
import { ago, fmt, fmtCost } from "./format";
import type { Insight, SessionRecord } from "./types";
import type { LiveState } from "./useLiveTail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Snapshot = { key: string; session?: SessionRecord; insights?: Insight[]; error?: string; fetchedAt?: number };

/** Fetch authoritative totals; receipt events are invalidations, not usage deltas. */
function useSnapshots(live: LiveState, retry: number) {
  const [snapshots, setSnapshots] = useState(new Map<string, Snapshot>());
  const pending = useRef(new Map<string, AbortController>());
  useEffect(() => {
    for (const activity of live.activities) {
      const id = activity.sessionId;
      const key = `${live.connections}:${activity.revision}:${retry}`;
      if (snapshots.get(id)?.key === key || pending.current.has(id)) continue;
      const controller = new AbortController();
      pending.current.set(id, controller);
      Promise.all([api.session(id, controller.signal), api.sessionInsights(id, controller.signal)])
        .then(([{ session }, { insights }]) => ({ key, session, insights, fetchedAt: Date.now() }))
        .catch((error: unknown) => ({ key, error: error instanceof Error ? error.message : "Snapshot unavailable" }))
        .then(snapshot => {
          if (controller.signal.aborted || pending.current.get(id) !== controller) return;
          pending.current.delete(id);
          setSnapshots(previous => {
            const next = new Map(previous);
            const last = previous.get(id);
            next.delete(id); next.set(id, "error" in snapshot ? { ...last, ...snapshot } : snapshot);
            if (next.size > 200) next.delete(next.keys().next().value!);
            return next;
          });
        });
    }
  }, [live.activities, live.connections, retry, snapshots]);
  useEffect(() => () => { for (const controller of pending.current.values()) controller.abort(); pending.current.clear(); }, []);
  return snapshots;
}

export function LiveActivity({ live, onClose, onOpenSession }: {
  live: LiveState & { reconnect: () => void }; onClose: () => void; onOpenSession: (id: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const snapshots = useSnapshots(live, retry);
  const [paused, setPaused] = useState<{ live: LiveState; snapshots: Map<string, Snapshot> } | null>(null);
  const [raw, setRaw] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [filter, setFilter] = useState("");
  const [, tick] = useState(0);
  useEffect(() => { const interval = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(interval); }, []);
  const shown = paused?.live ?? live;
  const records = paused?.snapshots ?? snapshots;
  const query = filter.toLowerCase();
  const activities = shown.activities.filter(a => `${a.sessionId} ${records.get(a.sessionId)?.session?.title ?? ""}`.toLowerCase().includes(query));
  const connectionLabel = { connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", disconnected: "Disconnected" }[live.connection];
  return (
    <section id="session-activity" tabIndex={-1} aria-label="Session activity" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="text-sm font-medium">Activity</h2>
          <p className="text-xs text-secondary-foreground">
            <span role="status">{connectionLabel}</span> · {live.lastEventAt ? `last receipt ${ago(new Date(live.lastEventAt).toISOString())}` : "no updates received yet"}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close session activity" onClick={onClose}><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setPaused(p => p ? null : { live, snapshots: new Map(snapshots) })}>
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}{paused ? "Resume" : "Pause display"}
          </Button>
          <Button size="sm" variant="ghost" aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? "Session groups" : "Raw events"}</Button>
          {live.connection !== "connected" && <Button size="sm" onClick={live.reconnect}><RefreshCw className="h-3 w-3" />Reconnect</Button>}
        </div>
        {paused && <p className="text-xs text-secondary-foreground">Display paused · {fmt(live.receivedCount - paused.live.receivedCount)} updates waiting. Capture continues.</p>}
        <input aria-label="Filter activity by session title or ID" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by session title or ID…" className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs placeholder:text-secondary-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
        <p className="text-xs leading-relaxed text-muted-foreground">Session totals, not event sums. Updates start when you open this page; reconnect does not replay history.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {raw ? (
          <div className="divide-y divide-border">
            <p className="p-3 text-xs text-secondary-foreground">Newest received first. Receipt order is not execution chronology.</p>
            {shown.events.filter(e => !query || `${e.sessionId ?? ""} ${e.sessionId ? records.get(e.sessionId)?.session?.title ?? "" : ""}`.toLowerCase().includes(query)).map(event => (
              <details key={event.sequence} className="px-3 py-2 text-xs">
                <summary className="cursor-pointer"><time>{new Date(event.receivedAt).toLocaleTimeString()}</time> · {event.type}</summary>
                <pre className="body-pre mt-2">{JSON.stringify(event.data, null, 2)}</pre>
              </details>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">
            <div className="grid grid-cols-[minmax(0,1fr)_4rem_5rem] gap-2 px-4 py-3 text-xs text-muted-foreground"><span>Session</span><span className="text-right">Calls¹</span><span className="text-right">Cost²</span></div>
            {!activities.length && <div className="empty-workspace"><div><h2>{shown.activities.length ? "No matching activity" : "Waiting for the next update"}</h2><p>{shown.activities.length ? "Try a different session title or ID." : live.connection === "connected" ? "The stream is connected. Existing sessions are available in session review." : "The event connection is not ready. Your saved history is still available."}</p></div></div>}
            {activities.map(activity => {
              const snapshot = records.get(activity.sessionId);
              const session = snapshot?.session;
              const findings = snapshot?.insights?.filter(i => i.severity !== "info") ?? [];
              const isExpanded = expanded.has(activity.sessionId);
              const refreshing = snapshot?.key !== `${shown.connections}:${activity.revision}:${retry}`;
              return <div key={activity.sessionId} className="px-4 py-4">
                <div className="grid grid-cols-[minmax(0,1fr)_4rem_5rem] items-start gap-2">
                  <div className="flex min-w-0 items-start gap-1">
                    <button aria-label={`${isExpanded ? "Collapse" : "Expand"} activity for ${session?.title || activity.sessionId}`} aria-expanded={isExpanded} className="mt-0.5 shrink-0 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(activity.sessionId)) next.delete(activity.sessionId); else next.add(activity.sessionId); return next; })}><ChevronRight className={cn("h-3.5 w-3.5", isExpanded && "rotate-90")} /></button>
                    <div className="min-w-0">
                      <a href={`#/sessions/${activity.sessionId}`} className="block break-words text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onOpenSession(activity.sessionId); }}>{session?.title || activity.sessionId}</a>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{session ? session.model ?? "Model not recorded" : snapshot?.error ? "Metadata read failed" : "Reading session metadata…"}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{snapshot?.error ? "Snapshot read failed; shown values may be stale." : refreshing ? "Refreshing snapshot; shown values may be stale." : snapshot?.fetchedAt ? `Snapshot read ${ago(new Date(snapshot.fetchedAt).toISOString())}` : "Waiting for snapshot."}</p>
                      {snapshot?.error && <button className="text-[11px] text-primary underline disabled:opacity-50" disabled={!!paused} onClick={() => setRetry(n => n + 1)}>{paused ? "Resume to retry" : "Retry reads"}</button>}
                      {findings.length > 0 && <p className="mt-1 text-xs text-amber">{findings.length} recorded-error {findings.length === 1 ? "finding" : "findings"}{refreshing || snapshot?.error ? " (last loaded)" : ""}</p>}
                    </div>
                  </div>
                  <span className="text-right text-xs tabular-nums">{session ? `${fmt(session.llmCallCount)} / ${fmt(session.toolCallCount)}` : "Unknown"}</span>
                  <span className="text-right text-xs tabular-nums">{fmtCost(session?.costTotal)}</span>
                </div>
                {isExpanded && <div className="mt-2 space-y-2 pl-5 text-xs text-secondary-foreground">
                  <code className="block break-all">{activity.sessionId}</code>
                  <p>Latest received update: {activity.latestUpdate}</p>
                  <p>Receipt: {new Date(activity.receivedAt).toLocaleTimeString()}. Receipt time is not execution or snapshot time.</p>
                  <p>Recorded cost is not necessarily billed spend. {session?.capture?.partial ? "Imported history is partial." : "Values reflect recorded collector data."}</p>
                  {snapshot?.error && <p>Read error: {snapshot.error}</p>}
                  {snapshot?.insights?.map(i => <p key={i.id}>{i.title}</p>)}
                </div>}
              </div>;
            })}
          </div>
        )}
      </div>
      <details className="shrink-0 border-t border-border px-4 py-3 text-xs text-muted-foreground"><summary>{shown.activities.length} sessions · {shown.events.length} retained updates</summary><p className="mt-2 leading-relaxed">{shown.droppedEvents} older raw updates discarded · {shown.droppedSessions} older groups discarded · {shown.ungroupedEvents} ungrouped raw updates.</p><p className="mt-2">¹ Model calls / tool calls. ² Recorded cost, not necessarily billed spend. Retention is limited to 100 session groups and 200 raw receipts.</p></details>
    </section>
  );
}
