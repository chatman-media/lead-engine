// Coverage for the shadow-eval start/poll routes in
// `src/admin/routes/shadow-eval.ts` — validation branches.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { CoachProposalsRepo } from "@/db/repos/coach-proposals.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import type { CoachProposal } from "@/sales/coach.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const DIM = 8;
const SAMPLE: CoachProposal = { summary: "x", edits: {}, rationale: ["r"] };

const ragDeps = {
  chat: { complete: async () => "{}" },
  embedder: { dim: DIM, embed: async (xs: string[]) => xs.map(() => new Array(DIM).fill(0)) },
} as unknown as Parameters<typeof createRouter>[0]["rag"];

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;
let adminId: number;

async function startServer(withRag: boolean) {
  const telegram = new TelegramClient({ token: "t", fetch: async () => new Response("{}") });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    ...(withRag ? { rag: ragDeps } : {}),
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  const admins = new AdminsRepo(sql);
  const existing = await admins.byEmail("op-shadoweval@x.test");
  adminId =
    existing?.id ??
    (await admins.create({ email: "op-shadoweval@x.test", password: "longenough" })).id;
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op-shadoweval@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(() => startServer(true), 30_000);
afterEach(() => server.stop(true));

const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const authed = (extra: RequestInit = {}): RequestInit => ({
  ...extra,
  headers: { ...(extra.headers ?? {}), cookie },
});
const post = (p: string) => fetch(url(p), authed({ method: "POST" }));

describe("POST /admin/api/coach/:id/shadow-eval", () => {
  test("503 when the LLM is not configured", async () => {
    server.stop(true);
    await startServer(false);
    expect((await post("/admin/api/coach/1/shadow-eval")).status).toBe(503);
  });

  test("400 for a non-numeric proposal id", async () => {
    expect((await post("/admin/api/coach/abc/shadow-eval")).status).toBe(400);
  });

  test("404 when the proposal does not exist", async () => {
    expect((await post("/admin/api/coach/999999/shadow-eval")).status).toBe(404);
  });

  test("409 when the proposal has not been applied yet", async () => {
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    const proposal = await new CoachProposalsRepo(sql).insert({
      styleSlug: flirtyBelfort.slug,
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE,
    });
    const res = await post(`/admin/api/coach/${proposal.id}/shadow-eval`);
    expect(res.status).toBe(409);
  });

  test("409 when the applied proposal's style row has no parent", async () => {
    await seedBuiltinStyles(new StylesRepo(sql), [flirtyBelfort]);
    const repo = new CoachProposalsRepo(sql);
    const proposal = await repo.insert({
      styleSlug: flirtyBelfort.slug,
      sampleSize: 8,
      personaFilter: null,
      proposal: SAMPLE,
    });
    await repo.decide({ id: proposal.id, status: "applied", adminId });
    const res = await post(`/admin/api/coach/${proposal.id}/shadow-eval`);
    // The builtin style row has parent_id = null → "no parent" guard.
    expect(res.status).toBe(409);
  });
});

describe("GET /admin/api/coach/:id/shadow-eval", () => {
  test("requires auth", async () => {
    expect((await fetch(url("/admin/api/coach/1/shadow-eval"))).status).toBe(401);
  });

  test("returns shadow_eval: null when no evaluation has run", async () => {
    const res = await fetch(url("/admin/api/coach/1/shadow-eval"), authed());
    expect(res.status).toBe(200);
    expect((await res.json()) as { shadow_eval: unknown }).toEqual({ shadow_eval: null });
  });

  test("400 for a non-numeric proposal id", async () => {
    expect((await fetch(url("/admin/api/coach/abc/shadow-eval"), authed())).status).toBe(400);
  });
});
