const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  sessions: () => apiFetch<{ sessions: import("./types").SessionRecord[] }>("/api/sessions?limit=200"),
  session: (id: string) => apiFetch<{ session: import("./types").SessionRecord }>(`/api/sessions/${id}`),
  turns: (sessionId: string) => apiFetch<{ turns: import("./types").TurnRecord[] }>(`/api/sessions/${sessionId}/turns`),
  sessionInsights: (sessionId: string) => apiFetch<{ insights: import("./types").Insight[] }>(`/api/sessions/${sessionId}/insights`),
  llmCalls: (turnId: string) => apiFetch<{ llmCalls: import("./types").LlmCallRecord[] }>(`/api/turns/${turnId}/llm-calls`),
  toolCalls: (turnId: string) => apiFetch<{ toolCalls: import("./types").ToolCallRecord[] }>(`/api/turns/${turnId}/tool-calls`),
  segments: (llmCallId: string) => apiFetch<{ segments: import("./types").PromptSegmentRecord[] }>(`/api/llm-calls/${llmCallId}/segments`),
  blob: (ref: string) => fetch(`${BASE}/api/blobs/${ref}`).then((r) => r.text()),
  compare: (harnesses?: string[]) =>
    apiFetch<{ compare: import("./types").CompareResult }>(
      `/api/compare${harnesses?.length ? `?harnesses=${harnesses.join(",")}` : ""}`
    ),
  profile: (sessionId: string) =>
    fetch(`${BASE}/api/sessions/${sessionId}/profile`, { method: "POST" }).then(
      (r) => r.json() as Promise<{ insights: import("./types").Insight[] }>
    ),
};
