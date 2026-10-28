import { Service } from "@opencode/client/service";

export async function importOpenCode(args: string[], defaultPort: number): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    if (!["--opencode-url", "--endpoint", "--session"].includes(key) || !args[i + 1] || args[i + 1]!.startsWith("--")) {
      throw new Error(`Expected --session ID, --opencode-url URL, or --endpoint URL; got ${key}`);
    }
    options.set(key, args[i + 1]!);
  }
  const endpoint = options.has("--opencode-url") ? undefined : await Service.discover();
  if (!options.has("--opencode-url") && !endpoint) throw new Error("OpenCode service not running. Open OpenCode first, or provide --opencode-url.");
  const source = options.get("--opencode-url") ?? endpoint!.url;
  const headers = endpoint ? Service.headers(endpoint) : process.env.OPENCODE_TOKEN
    ? { authorization: `Bearer ${process.env.OPENCODE_TOKEN}` } : {};
  async function read(path: string): Promise<any> {
    const res = await fetch(new URL(path, source), { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`OpenCode ${path}: HTTP ${res.status}`);
    return res.json();
  }
  const target = options.get("--endpoint") ?? `http://127.0.0.1:${defaultPort}`;
  // Check compatibility before reading potentially sensitive exports.
  const health = await fetch(new URL("/healthz", target), { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`Collector unavailable: HTTP ${health.status}`);
  let count = 0;
  const seen = new Set<string>();
  async function transfer(id: string): Promise<void> {
    if (seen.has(id)) return;
    seen.add(id);
    const exported = await read(`/api/experimental/session/${encodeURIComponent(id)}/export?sanitize=false`);
    const res = await fetch(new URL("/api/import/opencode", target), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exported.data), signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Import ${id}: HTTP ${res.status}${res.status === 404 ? " (upgrade the collector to a release supporting historical import)" : ""}`);
    const result = await res.json() as { skipped?: string };
    if (result.skipped) console.log(`Skipped ${id}: ${result.skipped}`);
    else { count++; console.log(`Imported ${id}`); }
  }
  if (options.has("--session")) await transfer(options.get("--session")!);
  else {
    // Explicitly request both states rather than relying on server defaults.
    for (const archived of ["false", "true"]) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: "100", order: "asc", archived });
        if (cursor) query.set("cursor", cursor);
        const page = await read(`/api/session?${query}`);
        if (!Array.isArray(page.data)) throw new Error("Unexpected OpenCode session-list response");
        for (const session of page.data) await transfer(session.id);
        cursor = page.cursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("OpenCode returned a repeated pagination cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
  }
  console.log(`${count} session(s) imported. Partial history: exact prompts and historical tool schemas are unavailable.`);
}
