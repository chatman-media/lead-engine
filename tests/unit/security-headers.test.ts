import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { AdminWsData } from "@/admin/bus.ts";
import { openDb } from "@/db/sqlite.ts";
import { createServer } from "@/server.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";

let db: ReturnType<typeof openDb>;
let server: Server<AdminWsData>;
let baseUrl: string;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  server = createServer({
    db,
    telegram,
    webhookSecret: "s",
    port: 0,
    serveUi: false,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  db.close();
});

describe("security headers", () => {
  test("/health response carries CSP + companion headers", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(r.headers.get("permissions-policy")).toContain("camera=()");
  });

  test("404 response also carries headers (fail-closed defaults)", async () => {
    const r = await fetch(`${baseUrl}/does-not-exist`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-security-policy")).toBeTruthy();
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  test("admin login JSON 401 carries headers", async () => {
    const r = await fetch(`${baseUrl}/admin/api/me`);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-security-policy")).toBeTruthy();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("CSP forbids inline scripts (script-src does not include 'unsafe-inline')", async () => {
    const r = await fetch(`${baseUrl}/health`);
    const csp = r.headers.get("content-security-policy") ?? "";
    // The whole script-src directive — no 'unsafe-inline', no 'unsafe-eval'.
    const scriptDirective = csp
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("script-src"));
    expect(scriptDirective).toBeDefined();
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(scriptDirective).not.toContain("*");
  });
});
