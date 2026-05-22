// Unit test: widget-static serving works (404 если bundle не built, 200 +
// correct content-type + CORS если built).

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { makeWidgetStaticRoutes } from "./widget-static.ts";

const app = new Hono();
app.route("/", makeWidgetStaticRoutes());

describe("widget-static", () => {
  it("GET /widget.js → 200 with correct headers (если built)", async () => {
    const res = await app.request("/widget.js");
    if (res.status === 404) {
      // Bundle ещё не built — это OK в свежем clone. Тест gracefully skip.
      console.warn("widget bundle не найден — `bun --cwd apps/widget build` сначала");
      return;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toMatch(/max-age/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(1000); // ~10KB raw
    // Sanity check — bundle содержит mountWidget call somewhere.
    expect(body).toMatch(/lead-engine-widget-host|le-bubble|user_text/);
  });

  it("GET /widget.js.map → 200 если source-map есть", async () => {
    const res = await app.request("/widget.js.map");
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("GET /demo/web-chat.html → 200 (demo всегда есть в repo)", async () => {
    const res = await app.request("/demo/web-chat.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/html/);
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
  });

  it("GET /widget/other.js (не в allow-list) → 404 (Hono default)", async () => {
    const res = await app.request("/widget/other.js");
    expect(res.status).toBe(404);
  });

  it("/widget.js имеет CORS allow-origin: *", async () => {
    const res = await app.request("/widget.js");
    if (res.status === 404) return;
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
