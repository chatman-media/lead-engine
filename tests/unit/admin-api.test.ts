import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";

const SECRET = "s";

function setup() {
  const db = openDb({ path: ":memory:" });
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({ db, telegram, webhookSecret: SECRET });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { db, server };
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

let ctx: ReturnType<typeof setup>;
let cookie: string;

beforeEach(async () => {
  ctx = setup();
  const admins = new AdminsRepo(ctx.db);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${ctx.server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  const set = login.headers.get("set-cookie")!;
  cookie = set.split(";")[0]!;
});
afterEach(() => teardown(ctx));

function url(path: string) {
  return `http://127.0.0.1:${ctx.server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return {
    ...extra,
    headers: { ...(extra.headers ?? {}), cookie },
  };
}

describe("leads endpoints", () => {
  test("GET /admin/api/leads requires auth and returns counts baseline", async () => {
    expect((await fetch(url("/admin/api/leads"))).status).toBe(401);

    const r = await fetch(url("/admin/api/leads"), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      leads: unknown[];
      counts: Record<string, number>;
    };
    expect(body.leads).toEqual([]);
    expect(body.counts.intake_pending).toBe(0);
    expect(body.counts.approved).toBe(0);
  });

  test("POST /admin/api/leads/from-conversation/:id promotes idempotently", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9001 });
    const c = conversations.ensureForUser(u.id);

    const first = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    expect(first.status).toBe(200);
    const body1 = (await first.json()) as {
      lead: { id: number; user_id: number; state: string };
    };
    expect(body1.lead.user_id).toBe(u.id);
    expect(body1.lead.state).toBe("intake_complete");

    // Calling again with the same conversation returns the same lead.
    const second = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const body2 = (await second.json()) as { lead: { id: number } };
    expect(body2.lead.id).toBe(body1.lead.id);
  });

  test("POST /admin/api/leads/:id/approve transitions through docs_pending", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9002 });
    const c = conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };

    const r = await fetch(
      url(`/admin/api/leads/${lead.id}/approve`),
      authed({ method: "POST" }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      lead: { state: string; decided_by_admin_id: number | null };
    };
    // After approve we transition into docs_pending so the bot starts
    // collecting visa form fields.
    expect(body.lead.state).toBe("docs_pending");
  });

  test("POST /admin/api/leads/:id/reject records reason and locks state", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9003 });
    const c = conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };

    const r = await fetch(
      url(`/admin/api/leads/${lead.id}/reject`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "не подходит по возрасту" }),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      lead: { state: string; rejected_reason: string };
    };
    expect(body.lead.state).toBe("rejected");
    expect(body.lead.rejected_reason).toBe("не подходит по возрасту");

    // Subsequent approve attempt is 409 conflict.
    const conflict = await fetch(
      url(`/admin/api/leads/${lead.id}/approve`),
      authed({ method: "POST" }),
    );
    expect(conflict.status).toBe(409);
  });

  test("approve/reject return 404 for missing lead", async () => {
    const a = await fetch(
      url(`/admin/api/leads/99999/approve`),
      authed({ method: "POST" }),
    );
    expect(a.status).toBe(404);
    const r = await fetch(
      url(`/admin/api/leads/99999/reject`),
      authed({ method: "POST" }),
    );
    expect(r.status).toBe(404);
  });

  test("POST /admin/api/leads/:id/submit-to-visa allocates application_id and transitions to docs_complete", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9210 });
    const c = conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };
    await fetch(
      url(`/admin/api/leads/${lead.id}/approve`),
      authed({ method: "POST" }),
    );

    const submit = await fetch(
      url(`/admin/api/leads/${lead.id}/submit-to-visa`),
      authed({ method: "POST" }),
    );
    expect(submit.status).toBe(200);
    const body = (await submit.json()) as {
      lead: { state: string; application_id: string | null };
      application_id: string;
    };
    expect(body.lead.state).toBe("docs_complete");
    expect(body.lead.application_id).toBeTruthy();
    expect(body.application_id).toBe(body.lead.application_id!);
    const year = new Date().getFullYear();
    expect(body.application_id.startsWith(`VS-${year}-`)).toBe(true);
  });

  test("submit-to-visa is idempotent on application_id (re-submit returns same id)", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9211 });
    const c = conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(
        url(`/admin/api/leads/from-conversation/${c.id}`),
        authed({ method: "POST" }),
      )
    ).json()) as { lead: { id: number } };
    await fetch(
      url(`/admin/api/leads/${lead.id}/approve`),
      authed({ method: "POST" }),
    );

    const a = (await (
      await fetch(
        url(`/admin/api/leads/${lead.id}/submit-to-visa`),
        authed({ method: "POST" }),
      )
    ).json()) as { application_id: string };
    const b = (await (
      await fetch(
        url(`/admin/api/leads/${lead.id}/submit-to-visa`),
        authed({ method: "POST" }),
      )
    ).json()) as { application_id: string };
    expect(b.application_id).toBe(a.application_id);
  });

  test("GET /admin/api/leads/:id includes the timeline events array", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9_350 });
    const c = conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };
    await fetch(
      url(`/admin/api/leads/${lead.id}/approve`),
      authed({ method: "POST" }),
    );

    const r = await fetch(url(`/admin/api/leads/${lead.id}`), authed());
    const body = (await r.json()) as {
      events: Array<{
        from_state: string | null;
        to_state: string;
        by_admin_id: number | null;
      }>;
    };
    // Expect at least: created + intake_pending → intake_complete +
    // intake_complete → approved + approved → docs_pending = 4 events.
    expect(body.events.length).toBeGreaterThanOrEqual(4);
    expect(body.events[0]!.from_state).toBeNull();
    expect(body.events[0]!.to_state).toBe("intake_pending");
    const approved = body.events.find((e) => e.to_state === "approved");
    expect(approved).toBeDefined();
    expect(approved!.by_admin_id).not.toBeNull();
  });

  test("GET /admin/api/leads/:id returns lead detail with parsed intake/visa_docs", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9300 });
    const c = conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(
        url(`/admin/api/leads/from-conversation/${c.id}`),
        authed({ method: "POST" }),
      )
    ).json()) as { lead: { id: number } };

    const r = await fetch(url(`/admin/api/leads/${lead.id}`), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      lead: { id: number };
      user: { tg_user_id: number };
      intake: unknown;
      visa_docs: unknown;
      conversation_id: number | null;
      recent_messages: unknown[];
    };
    expect(body.lead.id).toBe(lead.id);
    expect(body.user.tg_user_id).toBe(9300);
    expect(body.conversation_id).toBe(c.id);
  });

  test("PATCH /admin/api/leads/:id/visa-docs merges patch with existing", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9301 });
    const c = conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(
        url(`/admin/api/leads/from-conversation/${c.id}`),
        authed({ method: "POST" }),
      )
    ).json()) as { lead: { id: number } };

    // First patch — sets two fields
    const r1 = await fetch(
      url(`/admin/api/leads/${lead.id}/visa-docs`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docs: { family_name: "Ivanova", phone: "+79991234567" },
        }),
      }),
    );
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as {
      visa_docs: Record<string, string>;
    };
    expect(body1.visa_docs.family_name).toBe("Ivanova");
    expect(body1.visa_docs.phone).toBe("+79991234567");

    // Second patch — adds one + clears one with empty string
    const r2 = await fetch(
      url(`/admin/api/leads/${lead.id}/visa-docs`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docs: { given_name: "Anna", phone: "" },
        }),
      }),
    );
    const body2 = (await r2.json()) as { visa_docs: Record<string, string> };
    expect(body2.visa_docs.family_name).toBe("Ivanova"); // preserved
    expect(body2.visa_docs.given_name).toBe("Anna"); // added
    expect(body2.visa_docs.phone).toBeUndefined(); // cleared
  });

  test("PATCH /admin/api/leads/:id/visa-docs drops unknown keys", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9302 });
    const c = conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(
        url(`/admin/api/leads/from-conversation/${c.id}`),
        authed({ method: "POST" }),
      )
    ).json()) as { lead: { id: number } };

    const r = await fetch(
      url(`/admin/api/leads/${lead.id}/visa-docs`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          docs: { family_name: "Ivanova", arbitrary_hack: "evil" },
        }),
      }),
    );
    const body = (await r.json()) as { visa_docs: Record<string, string> };
    expect(body.visa_docs.family_name).toBe("Ivanova");
    expect(body.visa_docs.arbitrary_hack).toBeUndefined();
  });

  test("submit-to-visa rejects leads in wrong state with 409", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9212 });
    const c = conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(
        url(`/admin/api/leads/from-conversation/${c.id}`),
        authed({ method: "POST" }),
      )
    ).json()) as { lead: { id: number } };
    // Promoted = intake_complete; submit-to-visa requires approved/docs_*.
    const r = await fetch(
      url(`/admin/api/leads/${lead.id}/submit-to-visa`),
      authed({ method: "POST" }),
    );
    expect(r.status).toBe(409);
  });

  test("status endpoint reports leads.by_state counts", async () => {
    const usersRepo = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = usersRepo.create({ tgUserId: 9100 });
    const c = conversations.ensureForUser(u.id);
    await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const r = await fetch(url("/admin/api/status"), authed());
    const body = (await r.json()) as {
      leads: { by_state: Record<string, number> };
    };
    expect(body.leads.by_state.intake_complete).toBe(1);
  });
});

describe("vacancies endpoints", () => {
  test("GET /admin/api/vacancies requires auth and returns []", async () => {
    expect((await fetch(url("/admin/api/vacancies"))).status).toBe(401);

    const r = await fetch(url("/admin/api/vacancies"), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as { vacancies: unknown[] };
    expect(body.vacancies).toEqual([]);
  });

  test("POST creates a vacancy; PATCH edits; DELETE removes", async () => {
    const create = await fetch(
      url("/admin/api/vacancies"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Шаохинг", body: "3000/смена" }),
      }),
    );
    expect(create.status).toBe(200);
    const created = (await create.json()) as {
      vacancy: { id: number; title: string; is_active: number };
    };
    expect(created.vacancy.title).toBe("Шаохинг");
    expect(created.vacancy.is_active).toBe(1);

    const patch = await fetch(
      url(`/admin/api/vacancies/${created.vacancy.id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false }),
      }),
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { vacancy: { is_active: number } };
    expect(patched.vacancy.is_active).toBe(0);

    const del = await fetch(
      url(`/admin/api/vacancies/${created.vacancy.id}`),
      authed({ method: "DELETE" }),
    );
    expect(del.status).toBe(200);
  });

  test("POST validates required title + body", async () => {
    const noTitle = await fetch(
      url("/admin/api/vacancies"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      }),
    );
    expect(noTitle.status).toBe(400);

    const noBody = await fetch(
      url("/admin/api/vacancies"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
    );
    expect(noBody.status).toBe(400);
  });

  test("PATCH 404 on missing id", async () => {
    const r = await fetch(
      url("/admin/api/vacancies/99999"),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
    );
    expect(r.status).toBe(404);
  });

  test("status endpoint reports active vacancy count", async () => {
    await fetch(
      url("/admin/api/vacancies"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "v1", body: "b1" }),
      }),
    );
    await fetch(
      url("/admin/api/vacancies"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "v2", body: "b2" }),
      }),
    );
    const r = await fetch(url("/admin/api/status"), authed());
    const body = (await r.json()) as { vacancies: { active: number } };
    expect(body.vacancies.active).toBe(2);
  });
});

describe("GET /admin/api/status", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/status"));
    expect(res.status).toBe(401);
  });

  test("returns the expected top-level shape", async () => {
    const res = await fetch(url("/admin/api/status"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rag).toBeDefined();
    expect(body.providers).toBeDefined();
    expect(body.routing).toBeDefined();
    expect(body.kb).toBeDefined();
    expect(body.conversations).toBeDefined();
    expect(body.users).toBeDefined();
    expect(body.messages).toBeDefined();
  });

  test("rag block reflects all six layer flags", async () => {
    const res = await fetch(url("/admin/api/status"), authed());
    const body = (await res.json()) as { rag: Record<string, unknown> };
    for (const flag of [
      "userMemory",
      "queryRewrite",
      "reflect",
      "hybridSearch",
      "conversationSummary",
      "topicRouting",
    ]) {
      expect(body.rag[flag]).toBeDefined();
      expect(typeof body.rag[flag]).toBe("boolean");
    }
    expect(typeof body.rag.topK).toBe("number");
  });

  test("kb counts by topic include untagged docs as null group", async () => {
    const users = new UsersRepo(ctx.db);
    users.create({ tgUserId: 800 }); // unrelated noise
    // Insert docs with mixed topics directly via SQL (KbRepo would do
    // the same thing).
    ctx.db.run(
      "INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('s1','t1','h1','visa')",
    );
    ctx.db.run(
      "INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('s2','t2','h2','payment')",
    );
    ctx.db.run(
      "INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('s3','t3','h3',NULL)",
    );

    const res = await fetch(url("/admin/api/status"), authed());
    const body = (await res.json()) as {
      kb: { documents: number; by_topic: Array<{ topic: string | null; documents: number }> };
    };
    expect(body.kb.documents).toBe(3);
    const topics = body.kb.by_topic.map((r) => r.topic);
    expect(topics).toContain("visa");
    expect(topics).toContain("payment");
    expect(topics).toContain(null);
  });

  test("conversations.with_summary counts non-null summary_json rows", async () => {
    const users = new UsersRepo(ctx.db);
    const convs = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 801 });
    const c = convs.ensureForUser(u.id);
    convs.setSummary(c.id, "обсуждали Дубай и сроки", 10);

    const res = await fetch(url("/admin/api/status"), authed());
    const body = (await res.json()) as {
      conversations: { with_summary: number; total: number };
    };
    expect(body.conversations.with_summary).toBe(1);
    expect(body.conversations.total).toBe(1);
  });

  test("users.with_memory counts users with extracted facts", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 802 });
    users.mergeMemoryFacts(u.id, { city: "Москва" });

    const res = await fetch(url("/admin/api/status"), authed());
    const body = (await res.json()) as { users: { with_memory: number; total: number } };
    expect(body.users.with_memory).toBe(1);
    expect(body.users.total).toBe(1);
  });
});

describe("GET /admin/api/users", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/users"));
    expect(res.status).toBe(401);
  });

  test("returns whitelist with status and counts", async () => {
    const users = new UsersRepo(ctx.db);
    users.create({ tgUserId: 11, tgUsername: "a", status: "qualified" });
    users.create({ tgUserId: 22, tgUsername: "b", status: "new" });

    const res = await fetch(url("/admin/api/users"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ tg_user_id: number; status: string }> };
    expect(body.users).toHaveLength(2);
    const ids = body.users.map((u) => u.tg_user_id).sort();
    expect(ids).toEqual([11, 22]);
  });
});

describe("GET /admin/api/conversations", () => {
  test("queued conversations come first, then by recency", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const messages = new MessagesRepo(ctx.db);

    const u1 = users.create({ tgUserId: 1 });
    const u2 = users.create({ tgUserId: 2 });
    const u3 = users.create({ tgUserId: 3 });

    const c1 = conversations.ensureForUser(u1.id);
    const c2 = conversations.ensureForUser(u2.id);
    const c3 = conversations.ensureForUser(u3.id);

    messages.add({ conversationId: c1.id, role: "user", text: "old" });
    conversations.touch(c1.id);
    messages.add({ conversationId: c2.id, role: "user", text: "newer" });
    conversations.touch(c2.id);
    conversations.setMode(c3.id, "queued");
    messages.add({ conversationId: c3.id, role: "user", text: "queued one" });
    conversations.touch(c3.id);

    const res = await fetch(url("/admin/api/conversations"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: number; mode: string; user: { tg_user_id: number } }>;
    };
    expect(body.conversations[0]!.mode).toBe("queued");
    expect(body.conversations[0]!.user.tg_user_id).toBe(3);
  });
});

describe("GET /admin/api/conversations/:id", () => {
  test("returns conversation, user, and messages", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const messages = new MessagesRepo(ctx.db);
    const u = users.create({ tgUserId: 99 });
    const c = conversations.ensureForUser(u.id);
    messages.add({ conversationId: c.id, role: "user", text: "hi" });
    messages.add({ conversationId: c.id, role: "assistant", text: "hello" });

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: number };
      user: { tg_user_id: number };
      messages: Array<{ role: string; text: string }>;
    };
    expect(body.conversation.id).toBe(c.id);
    expect(body.user.tg_user_id).toBe(99);
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
  });

  test("returns 404 for missing conversation", async () => {
    const res = await fetch(url("/admin/api/conversations/999999"), authed());
    expect(res.status).toBe(404);
  });

  test("includes empty memory object when no facts stored", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 510 });
    const c = conversations.ensureForUser(u.id);

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory).toBeDefined();
    expect(body.memory.facts).toEqual({});
  });

  test("includes stored memory facts", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 511 });
    const c = conversations.ensureForUser(u.id);
    users.mergeMemoryFacts(u.id, { city: "Москва", age: "25" });

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    const body = (await res.json()) as {
      memory: { facts: Record<string, string>; updatedAt?: number };
    };
    expect(body.memory.facts).toEqual({ city: "Москва", age: "25" });
    expect(body.memory.updatedAt).toBeGreaterThan(0);
  });
});

describe("PATCH /admin/api/users/:id/memory", () => {
  test("requires auth", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 600 });
    const res = await fetch(url(`/admin/api/users/${u.id}/memory`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts: { city: "x" } }),
    });
    expect(res.status).toBe(401);
  });

  test("replaces facts wholesale (operator edit is authoritative)", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 601 });
    users.mergeMemoryFacts(u.id, { city: "Москва", age: "25", intent: "Дубай" });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: { city: "Сочи", language: "ru" } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    // age and intent are GONE — operator edit replaces, not merges.
    expect(body.memory.facts).toEqual({ city: "Сочи", language: "ru" });

    // Persists across re-reads.
    const reread = users.getMemory(u.id);
    expect(reread.facts).toEqual({ city: "Сочи", language: "ru" });
  });

  test("trims whitespace and drops empty values", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 602 });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          facts: { city: "  Москва  ", empty: "  ", age: "26" },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory.facts).toEqual({ city: "Москва", age: "26" });
  });

  test("rejects 400 when facts is not an object", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 603 });
    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: ["not", "an", "object"] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for missing user", async () => {
    const res = await fetch(
      url("/admin/api/users/999999/memory"),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: {} }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("clears memory when facts is empty object", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 604 });
    users.mergeMemoryFacts(u.id, { city: "x" });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: {} }),
      }),
    );
    expect(res.status).toBe(200);
    expect(users.getMemory(u.id).facts).toEqual({});
  });

  test("caps oversized values to keep memory factual not essay-length", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 605 });
    const huge = "x".repeat(500);
    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: { ok: "fine", huge } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory.facts.ok).toBe("fine");
    expect(body.memory.facts.huge).toBeUndefined();
  });
});

describe("POST /admin/api/conversations/:id/take and /release", () => {
  test("take switches mode to human and records assigned admin", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 55 });
    const c = conversations.ensureForUser(u.id);

    const take = await fetch(
      url(`/admin/api/conversations/${c.id}/take`),
      authed({ method: "POST" }),
    );
    expect(take.status).toBe(200);
    const after = conversations.byId(c.id)!;
    expect(after.mode).toBe("human");
    expect(after.assigned_admin_id).not.toBeNull();
  });

  test("release switches mode back to ai and clears assignment", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: 56 });
    const c = conversations.ensureForUser(u.id);
    conversations.setMode(c.id, "human", 1);

    const rel = await fetch(
      url(`/admin/api/conversations/${c.id}/release`),
      authed({ method: "POST" }),
    );
    expect(rel.status).toBe(200);
    const after = conversations.byId(c.id)!;
    expect(after.mode).toBe("ai");
    expect(after.assigned_admin_id).toBeNull();
  });
});
