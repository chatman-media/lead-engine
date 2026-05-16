import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { SelfPlayMatchesRepo } from "@/db/repos/self-play-matches.ts";
import { TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;

beforeEach(async () => {
  const telegram = new TelegramClient({ token: "t", fetch: async () => new Response("{}") });
  const router = createRouter({ sql, telegram, webhookSecret: SECRET });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

  const admins = new AdminsRepo(sql);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterEach(() => server.stop(true));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), cookie },
});

async function seedMatch(overrides: Partial<Parameters<SelfPlayMatchesRepo["insert"]>[0]> = {}) {
  const repo = new SelfPlayMatchesRepo(sql);
  return repo.insert({
    styleSlug: "alina-infinity",
    personaSlug: "skeptic-anya",
    outcome: "won",
    judgeReason: "clear win",
    transcript: [{ role: "salesperson", text: "привет" }],
    turns: 1,
    skills: ["social_proof"],
    leadId: null,
    ...overrides,
  });
}

describe("GET /admin/api/self-play", () => {
  test("requires auth", async () => {
    expect((await fetch(url("/admin/api/self-play"))).status).toBe(401);
  });

  test("returns matches, matrix and persona catalogue", async () => {
    await seedMatch();
    const res = await fetch(url("/admin/api/self-play"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      matches: unknown[];
      matrix: unknown;
      personas: { slug: string }[];
    };
    expect(body.total).toBe(1);
    expect(body.matches).toHaveLength(1);
    expect(body.personas.some((p) => p.slug === "skeptic-anya")).toBe(true);
  });

  test("filters by outcome and style query params", async () => {
    await seedMatch({ outcome: "won" });
    await seedMatch({ outcome: "lost" });
    const res = await fetch(
      url("/admin/api/self-play?outcome=lost&style=alina-infinity"),
      authed(),
    );
    const body = (await res.json()) as { matches: { outcome: string }[] };
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]!.outcome).toBe("lost");
  });

  test("ignores an out-of-range limit and falls back to the default", async () => {
    await seedMatch();
    const res = await fetch(url("/admin/api/self-play?limit=99999"), authed());
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/api/self-play/:id", () => {
  test("returns the full transcript with a resolved persona display name", async () => {
    const m = await seedMatch();
    const res = await fetch(url(`/admin/api/self-play/${m.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      match: { id: number; persona_display_name: string; transcript: unknown[] };
    };
    expect(body.match.id).toBe(m.id);
    expect(body.match.persona_display_name).not.toBe("skeptic-anya");
    expect(body.match.transcript).toHaveLength(1);
  });

  test("404 for an unknown id", async () => {
    expect((await fetch(url("/admin/api/self-play/999999"), authed())).status).toBe(404);
  });

  test("400 for a non-numeric id", async () => {
    expect((await fetch(url("/admin/api/self-play/abc"), authed())).status).toBe(400);
  });
});

describe("DELETE /admin/api/self-play/:id", () => {
  test("deletes an existing match", async () => {
    const m = await seedMatch();
    const res = await fetch(url(`/admin/api/self-play/${m.id}`), authed({ method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleted: number }).toEqual({ ok: true, deleted: m.id });
    expect(await new SelfPlayMatchesRepo(sql).byId(m.id)).toBeNull();
  });

  test("404 when deleting a missing match", async () => {
    const res = await fetch(url("/admin/api/self-play/424242"), authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
