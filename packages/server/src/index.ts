import { Store } from "@agent-profiler/store";

const store = new Store({ filePath: process.env.AGENT_PROFILER_DB_PATH ?? "./agent-profiler.sqlite" });

const server = Bun.serve({
  port: Number(process.env.AGENT_PROFILER_PORT ?? 7070),
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, name: "agent-profiler" });
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      return Response.json({ sessions: store.listSessions(100) });
    }

    if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
      const id = url.pathname.split("/").pop();
      const session = id ? store.getSession(id) : undefined;
      return session ? Response.json({ session }) : new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/api/insights" && req.method === "GET") {
      const scopeType = url.searchParams.get("scopeType") ?? undefined;
      const scopeId = url.searchParams.get("scopeId") ?? undefined;
      return Response.json({ insights: store.listInsights(scopeType, scopeId) });
    }

    if (url.pathname === "/v1/traces" && req.method === "POST") {
      return req.arrayBuffer().then((body) => {
        // Placeholder ingestion path: store the raw body in a temporary session-shaped record later.
        // This keeps the server end-to-end bootable before OTLP protobuf decoding lands.
        console.log(`received OTLP payload bytes=${body.byteLength}`);
        return new Response(null, { status: 204 });
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`agent-profiler listening on http://localhost:${server.port}`);
