import { describe, expect, test } from "bun:test";

import { html, json, Router, text } from "@/router.ts";

const req = (method: string, path: string) => new Request(`https://example.com${path}`, { method });

describe("Router routing", () => {
  test("matches method + static path", async () => {
    const r = new Router().get("/health", () => text("ok"));
    const res = await r.handle(req("GET", "/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("returns 404 when no route matches", async () => {
    const r = new Router().get("/health", () => text("ok"));
    const res = await r.handle(req("GET", "/nope"));
    expect(res.status).toBe(404);
  });

  test("returns 404 when path matches but method does not", async () => {
    const r = new Router().get("/health", () => text("ok"));
    const res = await r.handle(req("POST", "/health"));
    expect(res.status).toBe(404);
  });

  test("extracts :params and decodes them", async () => {
    const r = new Router().get("/u/:id/:slug", (ctx) => json(ctx.params));
    const res = await r.handle(req("GET", "/u/42/a%2Fb"));
    expect(await res.json()).toEqual({ id: "42", slug: "a/b" });
  });

  test("escapes regex metacharacters in the path literal", async () => {
    const r = new Router().get("/v1.0/info", () => text("hit"));
    // The dot must be literal — "v1x0" must NOT match.
    expect((await r.handle(req("GET", "/v1x0/info"))).status).toBe(404);
    expect((await r.handle(req("GET", "/v1.0/info"))).status).toBe(200);
  });

  test("a param segment does not span a slash", async () => {
    const r = new Router().get("/u/:id", (ctx) => text(ctx.params.id ?? ""));
    expect((await r.handle(req("GET", "/u/1/2"))).status).toBe(404);
  });

  test("catches handler exceptions and returns 500", async () => {
    const r = new Router().get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await r.handle(req("GET", "/boom"));
    expect(res.status).toBe(500);
  });

  test("post/put/delete/patch register their verbs", async () => {
    const r = new Router()
      .post("/p", () => text("post"))
      .put("/p", () => text("put"))
      .delete("/p", () => text("delete"))
      .patch("/p", () => text("patch"));
    expect(await (await r.handle(req("POST", "/p"))).text()).toBe("post");
    expect(await (await r.handle(req("PUT", "/p"))).text()).toBe("put");
    expect(await (await r.handle(req("DELETE", "/p"))).text()).toBe("delete");
    expect(await (await r.handle(req("PATCH", "/p"))).text()).toBe("patch");
  });

  test("an ALL route matches any method", async () => {
    const r = new Router().add("ALL", "/any", () => text("any"));
    expect((await r.handle(req("GET", "/any"))).status).toBe(200);
    expect((await r.handle(req("POST", "/any"))).status).toBe(200);
  });

  test("first registered matching route wins", async () => {
    const r = new Router().get("/x", () => text("first")).get("/x", () => text("second"));
    expect(await (await r.handle(req("GET", "/x"))).text()).toBe("first");
  });
});

describe("response helpers", () => {
  test("html sets text/html content-type", () => {
    const res = html("<p>hi</p>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("json serializes the body and sets application/json", async () => {
    const res = json({ a: 1 });
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ a: 1 });
  });

  test("text sets text/plain content-type", () => {
    const res = text("plain");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("caller-supplied init (status + headers) is merged", () => {
    const res = json({ ok: true }, { status: 201, headers: { "x-trace": "abc" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-trace")).toBe("abc");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});
