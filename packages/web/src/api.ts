const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function apiFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => apiFetch<{ ok: boolean; demo?: boolean }>("/healthz", signal),
  sessions: async (signal?: AbortSignal) => {
    type Session = import("./types").SessionRecord;
    const sessions = new Map<string, Session>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let total = 0;
    do {
      const page: { sessions: Session[]; total: number; nextCursor: string | null } = await apiFetch(`/api/sessions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, signal);
      for (const session of page.sessions) sessions.set(session.id, session);
      total = page.total;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Collector repeated a session cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { sessions: [...sessions.values()], total };
  },
  session: (id: string, signal?: AbortSignal) => apiFetch<{ session: import("./types").SessionRecord }>(`/api/sessions/${id}`, signal),
  turns: (sessionId: string, signal?: AbortSignal) => apiFetch<{ turns: import("./types").TurnRecord[] }>(`/api/sessions/${sessionId}/turns`, signal),
  turn: (id: string, signal?: AbortSignal) => apiFetch<{ turn: import("./types").TurnRecord }>(`/api/turns/${id}`, signal),
  sessionInsights: (sessionId: string, signal?: AbortSignal) => apiFetch<{ insights: import("./types").Insight[] }>(`/api/sessions/${sessionId}/insights`, signal),
  llmCalls: (turnId: string, signal?: AbortSignal) => apiFetch<{ llmCalls: import("./types").LlmCallRecord[] }>(`/api/turns/${turnId}/llm-calls`, signal),
  toolCalls: (turnId: string, signal?: AbortSignal) => apiFetch<{ toolCalls: import("./types").ToolCallRecord[] }>(`/api/turns/${turnId}/tool-calls`, signal),
  segments: (llmCallId: string, signal?: AbortSignal) => apiFetch<{ segments: import("./types").PromptSegmentRecord[] }>(`/api/llm-calls/${llmCallId}/segments`, signal),
  blob: async (ref: string, signal?: AbortSignal) => {
    const response = await fetch(`${BASE}/api/blobs/${ref}`, { signal });
    if (!response.ok) throw new Error(`Evidence read failed (HTTP ${response.status})`);
    return response.text();
  },
  compare: (harnesses?: string[]) =>
    apiFetch<{ compare: import("./types").CompareResult }>(
      `/api/compare${harnesses?.length ? `?harnesses=${harnesses.join(",")}` : ""}`
    ),
  profile: async (sessionId: string) => {
    const response = await fetch(`${BASE}/api/sessions/${sessionId}/profile`, { method: "POST" });
    if (!response.ok) throw new Error(`Analysis HTTP ${response.status}`);
    return response.json() as Promise<{ insights: import("./types").Insight[] }>;
  },
};
