import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { PairwiseMatchesRepo } from "@/db/repos/pairwise-matches.ts";
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
  await admins.create({ email: "op-pairwise@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op-pairwise@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterEach(() => server.stop(true));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), cookie },
});

async function seedPair(overrides: Partial<Parameters<PairwiseMatchesRepo["insert"]>[0]> = {}) {
  const repo = new PairwiseMatchesRepo(sql);
  return repo.insert({
    styleASlug: "alina-infinity",
    styleBSlug: "cold-direct-pas",
    personaSlug: "skeptic-anya",
    winner: "a",
    judgeReason: "A clearer",
    matchAId: null,
    matchBId: null,
    eloAAfter: 1510,
    eloBAfter: 1490,
    ...overrides,
  });
}

describe("GET /admin/api/pairwise", () => {
  test("requires auth", async () => {
    expect((await fetch(url("/admin/api/pairwise"))).status).toBe(401);
  });

  test("returns matches, head-to-head matrix and personas", async () => {
    await seedPair();
    const res = await fetch(url("/admin/api/pairwise"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      matches: { persona_display_name: string }[];
      matrix: unknown;
      personas: unknown[];
    };
    expect(body.total).toBe(1);
    expect(body.matches[0]!.persona_display_name).not.toBe("skeptic-anya");
    expect(body.personas.length).toBeGreaterThan(0);
  });

  test("filters by winner query param", async () => {
    await seedPair({ winner: "a" });
    await seedPair({ winner: "b" });
    const res = await fetch(url("/admin/api/pairwise?winner=b"), authed());
    const body = (await res.json()) as { matches: { winner: string }[] };
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]!.winner).toBe("b");
  });
});

describe("GET /admin/api/pairwise/:id", () => {
  test("returns one pairwise verdict", async () => {
    const p = await seedPair();
    const res = await fetch(url(`/admin/api/pairwise/${p.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { match: { id: number } };
    expect(body.match.id).toBe(p.id);
  });

  test("404 for unknown id", async () => {
    expect((await fetch(url("/admin/api/pairwise/999999"), authed())).status).toBe(404);
  });

  test("400 for a non-numeric id", async () => {
    expect((await fetch(url("/admin/api/pairwise/xyz"), authed())).status).toBe(400);
  });
});

describe("DELETE /admin/api/pairwise/:id", () => {
  test("deletes an existing pairwise match", async () => {
    const p = await seedPair();
    const res = await fetch(url(`/admin/api/pairwise/${p.id}`), authed({ method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleted: number }).toEqual({ ok: true, deleted: p.id });
  });

  test("404 when deleting a missing match", async () => {
    const res = await fetch(url("/admin/api/pairwise/424242"), authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
