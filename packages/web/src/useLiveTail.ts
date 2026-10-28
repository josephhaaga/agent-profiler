import { useEffect, useRef, useState } from "react";

export type LiveEvent = { type: string; data: Record<string, unknown>; receivedAt: number; sequence: number; sessionId?: string };
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";
export type SessionActivity = { sessionId: string; receivedAt: number; revision: number; latestUpdate: string };
export interface LiveState {
  events: LiveEvent[];
  activities: SessionActivity[];
  connection: ConnectionState;
  connections: number;
  receivedCount: number;
  lastEventAt?: number;
  droppedEvents: number;
  droppedSessions: number;
  ungroupedEvents: number;
}

const initial = (): LiveState => ({ events: [], activities: [], connection: "connecting", connections: 0,
  receivedCount: 0, droppedEvents: 0, droppedSessions: 0, ungroupedEvents: 0 });

/** A bounded receipt ledger, never an accumulator of tokens, cost, or call totals. */
export function useLiveTail(enabled: boolean): LiveState & { reconnect: () => void } {
  const [state, setState] = useState<LiveState>(initial);
  const [attempt, setAttempt] = useState(0);
  const model = useRef<{ ledger: LiveState; groups: Map<string, SessionActivity>; owners: Map<string, string> } | null>(null);
  model.current ??= { ledger: initial(), groups: new Map(), owners: new Map() };
  useEffect(() => {
    if (!enabled) { setState(s => ({ ...s, connection: "disconnected" })); return; }
    let disposed = false;
    let flush: ReturnType<typeof setTimeout> | undefined;
    const { ledger, groups, owners } = model.current!;
    const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
    const stream = new EventSource(`${base}/api/stream`);
    const owner = (event: LiveEvent): string | undefined => {
      if (event.type === "session" && typeof event.data.id === "string") return event.data.id;
      if (typeof event.data.sessionId === "string") return event.data.sessionId;
      if (event.type === "insight") {
        if (event.data.scopeType === "session" && typeof event.data.scopeId === "string") return event.data.scopeId;
        const evidence = event.data.evidence as Record<string, unknown> | undefined;
        if (typeof evidence?.sessionId === "string") return evidence.sessionId;
        if (event.data.scopeType === "turn" && typeof event.data.scopeId === "string") return owners.get(event.data.scopeId);
      }
    };
    const publish = () => {
      if (flush) clearTimeout(flush);
      flush = undefined;
      if (disposed) return;
      setState({ ...ledger, events: ledger.events.map(event => ({ ...event, sessionId: owner(event) })), activities: [...groups.values()],
        ungroupedEvents: ledger.events.filter(e => !owner(e)).length });
    };
    ledger.connection = "connecting";
    publish();
    stream.onopen = () => {
      ledger.connection = "connected";
      ledger.connections++;
      publish(); // Reconnect is an invalidation, not evidence of durable replay.
    };
    stream.onerror = () => {
      ledger.connection = stream.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting";
      publish(); // EventSource owns retries; cleanup closes it and cancels our flush.
    };
    stream.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data);
        if (!parsed || typeof parsed.type !== "string" || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) return;
        const received: LiveEvent = { type: parsed.type, data: parsed.data, receivedAt: Date.now(), sequence: ++ledger.receivedCount };
        ledger.lastEventAt = received.receivedAt;
        ledger.events.unshift(received);
        if (ledger.events.length > 200) { ledger.events.pop(); ledger.droppedEvents++; }
        if (received.type === "turn" && typeof received.data.id === "string" && typeof received.data.sessionId === "string") {
          owners.set(received.data.id, received.data.sessionId);
          if (owners.size > 1000) owners.delete(owners.keys().next().value!);
        }
        const sessionId = owner(received);
        if (sessionId) {
          let latestUpdate = received.type.replaceAll("_", " ");
          if (received.type === "tool_call") latestUpdate = `Tool: ${String(received.data.name ?? "unknown")}`;
          else if (received.type === "llm_call") latestUpdate = `Model: ${String(received.data.model ?? "unknown")}`;
          else if (received.type === "session") latestUpdate = groups.get(sessionId)?.latestUpdate ?? "Session snapshot";
          groups.set(sessionId, { sessionId, receivedAt: received.receivedAt, revision: received.sequence, latestUpdate });
          if (groups.size > 100) {
            // Eviction is least-recently-received, while surviving row order
            // remains first-seen so active updates do not displace readers.
            let oldest: SessionActivity | undefined;
            for (const group of groups.values()) if (!oldest || group.revision < oldest.revision) oldest = group;
            if (oldest) groups.delete(oldest.sessionId);
            ledger.droppedSessions++;
          }
        }
        if (!flush) flush = setTimeout(publish, 500);
      } catch { /* Ignore malformed transport frames, not application errors. */ }
    };
    return () => { disposed = true; if (flush) clearTimeout(flush); stream.close(); };
  }, [enabled, attempt]);
  return { ...state, reconnect: () => setAttempt(value => value + 1) };
}
