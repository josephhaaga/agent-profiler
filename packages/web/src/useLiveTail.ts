import { useCallback, useEffect, useRef, useState } from "react";

export type LiveEvent = { type: string; data: unknown };

export function useLiveTail(enabled: boolean): LiveEvent[] {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }
    const base = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
    const es = new EventSource(`${base}/api/stream`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data as string) as LiveEvent;
        setEvents((prev) => [evt, ...prev].slice(0, 200));
      } catch {
        // ignore malformed SSE frames
      }
    };

    es.onerror = () => {
      es.close();
      // Reconnect after 3s
      setTimeout(() => {
        if (enabled) connect();
      }, 3000);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [enabled, connect]);

  return events;
}
