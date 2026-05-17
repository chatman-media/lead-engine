import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { enqueue, MAX_SEND_ATTEMPTS } from "@/db/repos/userbot-send-queue.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
const DIM = 8;

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;
let tgCalls: Array<{ method: string; payload: unknown }> = [];

beforeEach(async () => {
  tgCalls = [];
  // Telegram fake — records every Bot API call so tests can assert on
  // setWebhook / deleteWebhook side-effects without a real network round-trip.
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = url.split("/bot")[1]?.split("/")[1] ?? url;
    let payload: unknown = null;
    if (init?.body) {
      try {
        payload = JSON.parse(init.body as string);
      } catch {
        payload = init.body;
      }
    }
    tgCalls.push({ method, payload });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
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

afterEach(() => {
  server.stop(true);
});

function url(path: string) {
  return `http://127.0.0.1:${server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { ...(extra.headers ?? {}), cookie } };
}

async function auditRowCount(action: string): Promise<number> {
  const [row] = await sql<
    { n: number }[]
  >`SELECT COUNT(*)::INTEGER AS n FROM audit_log WHERE action = ${action}`;
  return row?.n ?? 0;
}

describe("POST /admin/api/ops/kb/wipe", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/ops/kb/wipe"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("400 without confirm:yes (foot-gun guard)", async () => {
    const res = await fetch(
      url("/admin/api/ops/kb/wipe"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(await auditRowCount("kb.wipe")).toBe(0);
  });

  test("with confirm:yes deletes documents+chunks and writes audit row", async () => {
    const kb = new KbRepo(sql);
    const doc = await kb.upsertDocument({
      source: "wipeme.md",
      title: "wipe",
      contentHash: "h1",
    });
    await kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "chunk",
      tokenCount: 1,
      embedding: new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
    });

    const res = await fetch(
      url("/admin/api/ops/kb/wipe"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "yes" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deleted_chunks: number;
      deleted_documents: number;
    };
    expect(body.ok).toBe(true);
    expect(body.deleted_documents).toBe(1);
    expect(body.deleted_chunks).toBe(1);

    const [docs] = await sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM kb_documents`;
    const [chunks] = await sql<{ n: number }[]>`SELECT COUNT(*)::INTEGER AS n FROM kb_chunks`;
    expect(docs?.n).toBe(0);
    expect(chunks?.n).toBe(0);

    expect(await auditRowCount("kb.wipe")).toBe(1);
  });
});

describe("DELETE /admin/api/ops/telegram/webhook", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/ops/telegram/webhook"), { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("calls Bot API deleteWebhook and writes audit row", async () => {
    const res = await fetch(
      url("/admin/api/ops/telegram/webhook"),
      authed({
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dropPending: true }),
      }),
    );
    expect(res.status).toBe(200);

    const call = tgCalls.find((c) => c.method === "deleteWebhook");
    expect(call).toBeDefined();
    expect(call!.payload).toEqual({ drop_pending_updates: true });

    expect(await auditRowCount("telegram.webhook.delete")).toBe(1);
  });

  test("empty body still works (dropPending defaults to false)", async () => {
    const res = await fetch(url("/admin/api/ops/telegram/webhook"), authed({ method: "DELETE" }));
    expect(res.status).toBe(200);
    const call = tgCalls.find((c) => c.method === "deleteWebhook");
    expect(call!.payload).toEqual({ drop_pending_updates: false });
  });
});

describe("POST /admin/api/ops/skill-outcomes/purge", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const ONE_DAY = 86_400;

  async function seedOutcomes() {
    // skill_outcomes.lead_id is NOT NULL → seed a user+lead first.
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 7777, tgUsername: "for-outcomes" });
    const leads = new LeadsRepo(sql);
    const lead = await leads.ensureForUser(u.id);

    // Old skill_outcome (120d) — should be purged at the 90-day default.
    await sql`
      INSERT INTO skill_outcomes (lead_id, skill_slug, outcome, source, created_at)
      VALUES (${lead.id}, 'reciprocity', 'won', 'manual', ${NOW - 120 * ONE_DAY})
    `;
    // Recent outcome — should survive.
    await sql`
      INSERT INTO skill_outcomes (lead_id, skill_slug, outcome, source, created_at)
      VALUES (${lead.id}, 'social_proof', 'won', 'manual', ${NOW - 5 * ONE_DAY})
    `;
    // Old self_play_match unreferenced by pairwise — eligible.
    await sql`
      INSERT INTO self_play_matches (style_slug, persona_slug, outcome, transcript_json, turns, created_at)
      VALUES ('s', 'p', 'won', '[]', 1, ${NOW - 120 * ONE_DAY})
    `;
    // Old self_play_match referenced by pairwise — preserved.
    const [protectedMatch] = await sql<{ id: number }[]>`
      INSERT INTO self_play_matches (style_slug, persona_slug, outcome, transcript_json, turns, created_at)
      VALUES ('s2', 'p2', 'won', '[]', 1, ${NOW - 120 * ONE_DAY})
      RETURNING id
    `;
    await sql`
      INSERT INTO pairwise_matches (style_a_slug, style_b_slug, persona_slug, winner, match_a_id, elo_a_after, elo_b_after, created_at)
      VALUES ('s2', 's', 'p', 'a', ${protectedMatch!.id}, 1500, 1500, ${NOW - 120 * ONE_DAY})
    `;
  }

  test("dryRun returns counts without deleting", async () => {
    await seedOutcomes();
    const res = await fetch(
      url("/admin/api/ops/skill-outcomes/purge"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 90, dryRun: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dry_run: boolean;
      would_delete: { skill_outcomes: number; self_play_matches: number };
    };
    expect(body.dry_run).toBe(true);
    expect(body.would_delete.skill_outcomes).toBe(1);
    expect(body.would_delete.self_play_matches).toBe(1);

    // No actual delete happened.
    const [outcomes] = await sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM skill_outcomes`;
    expect(outcomes?.n).toBe(2);
    expect(await auditRowCount("skill_outcomes.purge")).toBe(0);
  });

  test("real run deletes by cutoff, preserves pairwise-referenced rows, writes audit", async () => {
    await seedOutcomes();
    const res = await fetch(
      url("/admin/api/ops/skill-outcomes/purge"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ days: 90 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: { skill_outcomes: number; self_play_matches: number };
    };
    expect(body.deleted.skill_outcomes).toBe(1);
    expect(body.deleted.self_play_matches).toBe(1);

    // Only the recent outcome survives.
    const remainingOutcomes = await sql<
      { skill_slug: string }[]
    >`SELECT skill_slug FROM skill_outcomes`;
    expect(remainingOutcomes.map((r) => r.skill_slug)).toEqual(["social_proof"]);
    // The pairwise-referenced self_play_match must still exist.
    const [matches] = await sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM self_play_matches`;
    expect(matches?.n).toBe(1);

    expect(await auditRowCount("skill_outcomes.purge")).toBe(1);
  });

  test("defaults to 90 days when no body sent", async () => {
    await seedOutcomes();
    const res = await fetch(url("/admin/api/ops/skill-outcomes/purge"), authed({ method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(90);
  });
});

describe("POST /admin/api/ops/userbot/queue-stats", () => {
  test("derives statuses from sent_at / error / attempts (no status column)", async () => {
    // pending
    await enqueue(sql, 100, "p1");
    await enqueue(sql, 101, "p2");
    // sent
    const sentId = await enqueue(sql, 200, "sent");
    await sql`UPDATE userbot_send_queue SET sent_at = ${Math.floor(Date.now() / 1000)} WHERE id = ${sentId}`;
    // errored — has error but still within retry budget
    const errId = await enqueue(sql, 300, "err");
    await sql`UPDATE userbot_send_queue SET error = 'flood wait', attempts = 1 WHERE id = ${errId}`;
    // parked — attempts maxed out
    const parkedId = await enqueue(sql, 400, "parked");
    await sql`UPDATE userbot_send_queue SET error = 'forbidden', attempts = ${MAX_SEND_ATTEMPTS} WHERE id = ${parkedId}`;

    const res = await fetch(url("/admin/api/ops/userbot/queue-stats"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      by_status: Record<string, number>;
      userbot_enabled: boolean;
    };
    expect(body.by_status.pending).toBe(2);
    expect(body.by_status.sent).toBe(1);
    expect(body.by_status.errored).toBe(1);
    expect(body.by_status.parked).toBe(1);
  });

  test("empty queue returns empty by_status", async () => {
    const res = await fetch(url("/admin/api/ops/userbot/queue-stats"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { by_status: Record<string, number> };
    expect(body.by_status).toEqual({});
  });
});

describe("DELETE /admin/api/users/:id/data (GDPR right-to-erasure)", () => {
  async function seedUserWithData(): Promise<number> {
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 9001, tgUsername: "jane" });
    await users.setMemoryFacts(u.id, { city: "Tashkent" });

    const convs = new ConversationsRepo(sql);
    const conv = await convs.ensureForUser(u.id);
    const msgs = new MessagesRepo(sql);
    await msgs.add({ conversationId: conv.id, role: "user", text: "hello" });
    await msgs.add({ conversationId: conv.id, role: "assistant", text: "world" });

    const leads = new LeadsRepo(sql);
    await leads.ensureForUser(u.id);

    return u.id;
  }

  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/users/1/data"), { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("404 for unknown user", async () => {
    const res = await fetch(url("/admin/api/users/99999/data"), authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
  });

  test("tombstones the user, cascades conversation+lead, writes audit row", async () => {
    const userId = await seedUserWithData();

    const res = await fetch(url(`/admin/api/users/${userId}/data`), authed({ method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      user_id: number;
      conversations_deleted: number;
      leads_deleted: number;
    };
    expect(body.ok).toBe(true);
    expect(body.user_id).toBe(userId);
    expect(body.conversations_deleted).toBe(1);
    expect(body.leads_deleted).toBe(1);

    // User row is kept as a tombstone (so FK chains stay valid) but every
    // PII column is wiped. tg_user_id is set to -id (always negative, unique).
    const [row] = await sql<
      {
        tg_user_id: number;
        tg_username: string | null;
        status: string;
        profile_json: string | null;
      }[]
    >`SELECT tg_user_id, tg_username, status, profile_json FROM users WHERE id = ${userId}`;
    expect(row?.tg_user_id).toBe(-userId);
    expect(row?.tg_username).toBeNull();
    expect(row?.status).toBe("lost");
    expect(row?.profile_json).toBeNull();

    // Conversations / leads / messages all gone via ON DELETE CASCADE.
    const [conv] = await sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM conversations WHERE user_id = ${userId}`;
    const [leads] = await sql<
      { n: number }[]
    >`SELECT COUNT(*)::INTEGER AS n FROM leads WHERE user_id = ${userId}`;
    expect(conv?.n).toBe(0);
    expect(leads?.n).toBe(0);

    // Audit row with target pointer.
    const [audit] = await sql<
      { action: string; target_kind: string | null; target_id: string | null }[]
    >`SELECT action, target_kind, target_id FROM audit_log WHERE action = 'user.gdpr_erase'`;
    expect(audit?.action).toBe("user.gdpr_erase");
    expect(audit?.target_kind).toBe("user");
    expect(audit?.target_id).toBe(String(userId));
  });
});
