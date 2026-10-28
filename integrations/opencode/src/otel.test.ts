import { test, expect } from "bun:test";
import { initOtel } from "./otel.js";
import { CONFIG_DEFAULTS } from "./config.js";

test("location exporters stay independent when another runtime unloads", async () => {
  const projects: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const payload = await request.json() as { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }> };
      for (const resource of payload.resourceSpans) {
        projects.push(resource.resource.attributes.find((attr) => attr.key === "service.name")!.value.stringValue!);
      }
      return new Response(null, { status: 204 });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}/v1/traces`;
  const a = initOtel({ ...CONFIG_DEFAULTS, endpoint, projectName: "location-a" })!;
  const b = initOtel({ ...CONFIG_DEFAULTS, endpoint, projectName: "location-b" })!;
  try {
    a.tracer.startSpan("first").end();
    await a.shutdown();
    b.tracer.startSpan("second").end();
    await b.forceFlush();
    expect(projects).toEqual(["location-a", "location-b"]);
  } finally {
    await b.shutdown();
    server.stop(true);
  }
});
