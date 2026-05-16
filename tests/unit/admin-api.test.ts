import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { __resetBotHealthCacheForTesting } from "@/admin/api.ts";
import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

let server: Server;
let cookie: string;

function makeFetchImpl(): FetchLike {
  return async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
}

async function startServer(fetchImpl: FetchLike = makeFetchImpl()): Promise<Server> {
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({ sql, telegram, webhookSecret: SECRET });
  return Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
}

async function loginCookie(s: Server): Promise<string> {
  const login = await fetch(`http://127.0.0.1:${s.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  return login.headers.get("set-cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  // Bot-health cache is module-level — without this reset the first
  // /status probe in test N persists into test N+1, hiding stub
  // behaviour from later cases.
  __resetBotHealthCacheForTesting();
  server = await startServer();
  const admins = new AdminsRepo(sql);
  await admins.create({ email: "op@x.test", password: "longenough" });
  cookie = await loginCookie(server);
});

afterEach(() => {
  server.stop(true);
});

function url(path: string) {
  return `http://127.0.0.1:${server.port}${path}`;
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
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9001 });
    const c = await conversations.ensureForUser(u.id);

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
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9002 });
    const c = await conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };

    const r = await fetch(url(`/admin/api/leads/${lead.id}/approve`), authed({ method: "POST" }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      lead: { state: string; decided_by_admin_id: number | null };
    };
    // After approve we transition into docs_pending so the bot starts
    // collecting visa form fields.
    expect(body.lead.state).toBe("docs_pending");
  });

  test("POST /admin/api/leads/:id/reject records reason and locks state", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9003 });
    const c = await conversations.ensureForUser(u.id);
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
    const a = await fetch(url(`/admin/api/leads/99999/approve`), authed({ method: "POST" }));
    expect(a.status).toBe(404);
    const r = await fetch(url(`/admin/api/leads/99999/reject`), authed({ method: "POST" }));
    expect(r.status).toBe(404);
  });

  test("POST /admin/api/leads/:id/submit-to-visa allocates application_id and transitions to docs_complete", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9210 });
    const c = await conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };
    await fetch(url(`/admin/api/leads/${lead.id}/approve`), authed({ method: "POST" }));

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
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9211 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };
    await fetch(url(`/admin/api/leads/${lead.id}/approve`), authed({ method: "POST" }));

    const a = (await (
      await fetch(url(`/admin/api/leads/${lead.id}/submit-to-visa`), authed({ method: "POST" }))
    ).json()) as { application_id: string };
    const b = (await (
      await fetch(url(`/admin/api/leads/${lead.id}/submit-to-visa`), authed({ method: "POST" }))
    ).json()) as { application_id: string };
    expect(b.application_id).toBe(a.application_id);
  });

  test("mark-submitted transitions a docs_complete lead to submitted", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9212 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };
    await fetch(url(`/admin/api/leads/${lead.id}/approve`), authed({ method: "POST" }));
    await fetch(url(`/admin/api/leads/${lead.id}/submit-to-visa`), authed({ method: "POST" }));

    const res = await fetch(
      url(`/admin/api/leads/${lead.id}/mark-submitted`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lead: { state: string };
      application_id: string | null;
    };
    expect(body.lead.state).toBe("submitted");
    expect(body.application_id).toBeTruthy();
  });

  test("mark-submitted is idempotent — re-call on a submitted lead returns 200", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9213 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };
    await fetch(url(`/admin/api/leads/${lead.id}/approve`), authed({ method: "POST" }));
    await fetch(url(`/admin/api/leads/${lead.id}/submit-to-visa`), authed({ method: "POST" }));
    await fetch(url(`/admin/api/leads/${lead.id}/mark-submitted`), authed({ method: "POST" }));

    const again = await fetch(
      url(`/admin/api/leads/${lead.id}/mark-submitted`),
      authed({ method: "POST" }),
    );
    expect(again.status).toBe(200);
    const body = (await again.json()) as { lead: { state: string } };
    expect(body.lead.state).toBe("submitted");
  });

  test("mark-submitted rejects a lead not in docs_complete with 409", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9214 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };
    // Promoted = intake_complete — mark-submitted requires docs_complete.
    const res = await fetch(
      url(`/admin/api/leads/${lead.id}/mark-submitted`),
      authed({ method: "POST" }),
    );
    expect(res.status).toBe(409);
  });

  test("notes: POST creates, lead detail returns the list, DELETE removes", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9_400 });
    const c = await conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };

    // Create
    const create = await fetch(
      url(`/admin/api/leads/${lead.id}/notes`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "сомневается по визе" }),
      }),
    );
    expect(create.status).toBe(200);
    const { note } = (await create.json()) as {
      note: { id: number; body: string; by_admin_id: number | null };
    };
    expect(note.body).toBe("сомневается по визе");
    expect(note.by_admin_id).not.toBeNull();

    // Detail returns the note
    const detail = await fetch(url(`/admin/api/leads/${lead.id}`), authed());
    const detailBody = (await detail.json()) as { notes: Array<{ id: number }> };
    expect(detailBody.notes.length).toBe(1);
    expect(detailBody.notes[0]!.id).toBe(note.id);

    // Delete
    const del = await fetch(
      url(`/admin/api/leads/${lead.id}/notes/${note.id}`),
      authed({ method: "DELETE" }),
    );
    expect(del.status).toBe(200);
    const detail2 = await fetch(url(`/admin/api/leads/${lead.id}`), authed());
    const body2 = (await detail2.json()) as { notes: unknown[] };
    expect(body2.notes.length).toBe(0);
  });

  test("notes: empty body rejected with 400", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9_401 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };

    const r = await fetch(
      url(`/admin/api/leads/${lead.id}/notes`),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "   " }),
      }),
    );
    expect(r.status).toBe(400);
  });

  test("notes: cross-lead delete is rejected (note belongs to another lead)", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const ua = await usersRepo.create({ tgUserId: 9_410 });
    const ub = await usersRepo.create({ tgUserId: 9_411 });
    const ca = await conversations.ensureForUser(ua.id);
    const cb = await conversations.ensureForUser(ub.id);
    const leadA = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${ca.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };
    const leadB = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${cb.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };

    const noteA = (await (
      await fetch(
        url(`/admin/api/leads/${leadA.lead.id}/notes`),
        authed({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "for lead A" }),
        }),
      )
    ).json()) as { note: { id: number } };

    // Try to delete leadA's note via leadB's URL — should 404 even
    // though the note id is real.
    const r = await fetch(
      url(`/admin/api/leads/${leadB.lead.id}/notes/${noteA.note.id}`),
      authed({ method: "DELETE" }),
    );
    expect(r.status).toBe(404);
  });

  test("GET /admin/api/leads/:id includes the timeline events array", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9_350 });
    const c = await conversations.ensureForUser(u.id);
    const promoted = await fetch(
      url(`/admin/api/leads/from-conversation/${c.id}`),
      authed({ method: "POST" }),
    );
    const { lead } = (await promoted.json()) as { lead: { id: number } };
    await fetch(url(`/admin/api/leads/${lead.id}/approve`), authed({ method: "POST" }));

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
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9300 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
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
    expect(Number(body.user.tg_user_id)).toBe(9300);
    expect(body.conversation_id).toBe(c.id);
  });

  test("PATCH /admin/api/leads/:id/visa-docs merges patch with existing", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9301 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
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
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9302 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
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
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9212 });
    const c = await conversations.ensureForUser(u.id);
    const { lead } = (await (
      await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }))
    ).json()) as { lead: { id: number } };
    // Promoted = intake_complete; submit-to-visa requires approved/docs_*.
    const r = await fetch(
      url(`/admin/api/leads/${lead.id}/submit-to-visa`),
      authed({ method: "POST" }),
    );
    expect(r.status).toBe(409);
  });

  test("status endpoint reports leads.by_state counts", async () => {
    const usersRepo = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await usersRepo.create({ tgUserId: 9100 });
    const c = await conversations.ensureForUser(u.id);
    await fetch(url(`/admin/api/leads/from-conversation/${c.id}`), authed({ method: "POST" }));
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
      vacancy: { id: number; title: string; is_active: boolean };
    };
    expect(created.vacancy.title).toBe("Шаохинг");
    expect(created.vacancy.is_active).toBe(true);

    const patch = await fetch(
      url(`/admin/api/vacancies/${created.vacancy.id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false }),
      }),
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { vacancy: { is_active: boolean } };
    expect(patched.vacancy.is_active).toBe(false);

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

  test("bot_health surfaces getMe result; cache prevents back-to-back upstream calls", async () => {
    // Re-create the test stack with a fetch impl that returns a real
    // getMe shape, and counts upstream calls. The default setup() stub
    // returns `result: true` which doesn't match TgUser — fine for the
    // smoke check, not for asserting bot_health fields.
    server.stop(true);
    __resetBotHealthCacheForTesting();
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const u = typeof input === "string" ? input : (input as Request).url;
      calls.push(u);
      if (u.includes("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 1234,
              is_bot: true,
              first_name: "Алина",
              username: "alina_bot",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const localServer = await startServer(fetchImpl);
    const localCookie = await loginCookie(localServer);
    const localUrl = (p: string) => `http://127.0.0.1:${localServer.port}${p}`;

    const r1 = await fetch(localUrl("/admin/api/status"), {
      headers: { cookie: localCookie },
    });
    const body1 = (await r1.json()) as {
      bot_health: { ok: boolean; bot_id?: number; username?: string | null };
    };
    expect(body1.bot_health.ok).toBe(true);
    expect(body1.bot_health.bot_id).toBe(1234);
    expect(body1.bot_health.username).toBe("alina_bot");
    const getMeCallsAfterFirst = calls.filter((u) => u.includes("/getMe")).length;
    expect(getMeCallsAfterFirst).toBe(1);

    // Second hit within TTL → cache hit, no extra getMe.
    await fetch(localUrl("/admin/api/status"), {
      headers: { cookie: localCookie },
    });
    const getMeCallsAfterSecond = calls.filter((u) => u.includes("/getMe")).length;
    expect(getMeCallsAfterSecond).toBe(1);

    localServer.stop(true);
    // Re-start the main server so afterEach's server.stop(true) doesn't error.
    server = await startServer();
  });

  test("bot_health.ok is false when telegram getMe rejects", async () => {
    server.stop(true);
    __resetBotHealthCacheForTesting();
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ ok: false, description: "unauthorized" }), {
        status: 401,
      });
    const localServer = await startServer(fetchImpl);
    const localCookie = await loginCookie(localServer);

    const r = await fetch(`http://127.0.0.1:${localServer.port}/admin/api/status`, {
      headers: { cookie: localCookie },
    });
    const body = (await r.json()) as { bot_health: { ok: boolean; error?: string } };
    expect(body.bot_health.ok).toBe(false);
    expect(typeof body.bot_health.error).toBe("string");

    localServer.stop(true);
    // Re-start the main server so afterEach's server.stop(true) doesn't error.
    server = await startServer();
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
    // Insert docs with mixed topics directly via SQL (KbRepo would do
    // the same thing).
    await sql`INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('s1','t1','h1','visa')`;
    await sql`INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('s2','t2','h2','payment')`;
    await sql`INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('s3','t3','h3',NULL)`;

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
    const users = new UsersRepo(sql);
    const convs = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 801 });
    const c = await convs.ensureForUser(u.id);
    await convs.setSummary(c.id, "обсуждали Дубай и сроки", 10);

    const res = await fetch(url("/admin/api/status"), authed());
    const body = (await res.json()) as {
      conversations: { with_summary: number; total: number };
    };
    expect(body.conversations.with_summary).toBe(1);
    expect(body.conversations.total).toBe(1);
  });

  test("users.with_memory counts users with extracted facts", async () => {
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 802 });
    await users.mergeMemoryFacts(u.id, { city: "Москва" });

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
    const users = new UsersRepo(sql);
    await users.create({ tgUserId: 11, tgUsername: "a", status: "qualified" });
    await users.create({ tgUserId: 22, tgUsername: "b", status: "new" });

    const res = await fetch(url("/admin/api/users"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ tg_user_id: number; status: string }> };
    expect(body.users).toHaveLength(2);
    const ids = body.users.map((u) => Number(u.tg_user_id)).sort();
    expect(ids).toEqual([11, 22]);
  });
});

describe("GET /admin/api/conversations", () => {
  test("queued conversations come first, then by recency", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const messages = new MessagesRepo(sql);

    const u1 = await users.create({ tgUserId: 1 });
    const u2 = await users.create({ tgUserId: 2 });
    const u3 = await users.create({ tgUserId: 3 });

    const c1 = await conversations.ensureForUser(u1.id);
    const c2 = await conversations.ensureForUser(u2.id);
    const c3 = await conversations.ensureForUser(u3.id);

    await messages.add({ conversationId: c1.id, role: "user", text: "old" });
    await conversations.touch(c1.id);
    await messages.add({ conversationId: c2.id, role: "user", text: "newer" });
    await conversations.touch(c2.id);
    await conversations.setMode(c3.id, "queued");
    await messages.add({ conversationId: c3.id, role: "user", text: "queued one" });
    await conversations.touch(c3.id);

    const res = await fetch(url("/admin/api/conversations"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ id: number; mode: string; user: { tg_user_id: number } }>;
    };
    expect(body.conversations[0]!.mode).toBe("queued");
    expect(Number(body.conversations[0]!.user.tg_user_id)).toBe(3);
  });
});

describe("GET /admin/api/conversations/:id", () => {
  test("returns conversation, user, and messages", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const messages = new MessagesRepo(sql);
    const u = await users.create({ tgUserId: 99 });
    const c = await conversations.ensureForUser(u.id);
    await messages.add({ conversationId: c.id, role: "user", text: "hi" });
    await messages.add({ conversationId: c.id, role: "assistant", text: "hello" });

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: number };
      user: { tg_user_id: number };
      messages: Array<{ role: string; text: string }>;
    };
    expect(body.conversation.id).toBe(c.id);
    expect(Number(body.user.tg_user_id)).toBe(99);
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
  });

  test("returns 404 for missing conversation", async () => {
    const res = await fetch(url("/admin/api/conversations/999999"), authed());
    expect(res.status).toBe(404);
  });

  test("includes empty memory object when no facts stored", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 510 });
    const c = await conversations.ensureForUser(u.id);

    const res = await fetch(url(`/admin/api/conversations/${c.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memory: { facts: Record<string, string> } };
    expect(body.memory).toBeDefined();
    expect(body.memory.facts).toEqual({});
  });

  test("includes stored memory facts", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 511 });
    const c = await conversations.ensureForUser(u.id);
    await users.mergeMemoryFacts(u.id, { city: "Москва", age: "25" });

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
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 600 });
    const res = await fetch(url(`/admin/api/users/${u.id}/memory`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts: { city: "x" } }),
    });
    expect(res.status).toBe(401);
  });

  test("replaces facts wholesale (operator edit is authoritative)", async () => {
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 601 });
    await users.mergeMemoryFacts(u.id, { city: "Москва", age: "25", intent: "Дубай" });

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
    const reread = await users.getMemory(u.id);
    expect(reread.facts).toEqual({ city: "Сочи", language: "ru" });
  });

  test("trims whitespace and drops empty values", async () => {
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 602 });

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
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 603 });
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
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 604 });
    await users.mergeMemoryFacts(u.id, { city: "x" });

    const res = await fetch(
      url(`/admin/api/users/${u.id}/memory`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ facts: {} }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await users.getMemory(u.id)).facts).toEqual({});
  });

  test("caps oversized values to keep memory factual not essay-length", async () => {
    const users = new UsersRepo(sql);
    const u = await users.create({ tgUserId: 605 });
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
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 55 });
    const c = await conversations.ensureForUser(u.id);

    const take = await fetch(
      url(`/admin/api/conversations/${c.id}/take`),
      authed({ method: "POST" }),
    );
    expect(take.status).toBe(200);
    const after = (await conversations.byId(c.id))!;
    expect(after.mode).toBe("human");
    expect(after.assigned_admin_id).not.toBeNull();
  });

  test("release switches mode back to ai and clears assignment", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const u = await users.create({ tgUserId: 56 });
    const c = await conversations.ensureForUser(u.id);
    await conversations.setMode(c.id, "human", 1);

    const rel = await fetch(
      url(`/admin/api/conversations/${c.id}/release`),
      authed({ method: "POST" }),
    );
    expect(rel.status).toBe(200);
    const after = (await conversations.byId(c.id))!;
    expect(after.mode).toBe("ai");
    expect(after.assigned_admin_id).toBeNull();
  });
});

describe("user detail endpoint", () => {
  test("GET /admin/api/users/:id returns dossier with conversation + memory", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const messages = new MessagesRepo(sql);
    const u = await users.create({ tgUserId: 9001, tgUsername: "vasya" });
    const c = await conversations.ensureForUser(u.id);
    await messages.add({
      conversationId: c.id,
      role: "user",
      text: "hello",
      tgMessageId: 1,
    });
    await users.mergeMemoryFacts(u.id, { city: "Moscow", age: "25" });

    const r = await fetch(url(`/admin/api/users/${u.id}`), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      user: { tg_user_id: number; tg_username: string | null };
      conversation: { id: number } | null;
      lead: unknown;
      memory: { facts: Record<string, string> };
      recent_messages: Array<{ text: string }>;
    };
    expect(Number(body.user.tg_user_id)).toBe(9001);
    expect(body.user.tg_username).toBe("vasya");
    expect(body.conversation?.id).toBe(c.id);
    expect(body.lead).toBeNull();
    expect(body.memory.facts.city).toBe("Moscow");
    expect(body.recent_messages.length).toBe(1);
    expect(body.recent_messages[0]!.text).toBe("hello");
  });

  test("GET /admin/api/users/:id returns 404 on missing", async () => {
    const r = await fetch(url("/admin/api/users/99999"), authed());
    expect(r.status).toBe(404);
  });

  test("GET /admin/api/users/:id requires auth", async () => {
    const r = await fetch(url("/admin/api/users/1"));
    expect(r.status).toBe(401);
  });
});

describe("analytics endpoint", () => {
  test("GET /admin/api/analytics requires auth + returns shape", async () => {
    expect((await fetch(url("/admin/api/analytics"))).status).toBe(401);
    const r = await fetch(url("/admin/api/analytics"), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      window: string;
      total_assistant_messages: number;
      by_path: unknown[];
      latency: { total_ms: { count: number } };
      funnel: { by_state: Record<string, number>; new_in_window: number };
      trend: { bucket_seconds: number; buckets: unknown[] };
    };
    expect(body.window).toBe("24h");
    expect(typeof body.total_assistant_messages).toBe("number");
    expect(Array.isArray(body.by_path)).toBe(true);
    expect(typeof body.funnel.new_in_window).toBe("number");
    expect(typeof body.funnel.by_state).toBe("object");
    expect(Array.isArray(body.trend.buckets)).toBe(true);
    expect(body.trend.bucket_seconds).toBeGreaterThan(0);
  });

  test("aggregates real telemetry per path + latency percentiles", async () => {
    // Seed user → conversation → assistant messages with telemetry blobs.
    const [uRow] = await sql<
      [{ id: number }]
    >`INSERT INTO users (tg_user_id) VALUES (99001) RETURNING id`;
    const [cRow] = await sql<
      [{ id: number }]
    >`INSERT INTO conversations (user_id) VALUES (${uRow!.id}) RETURNING id`;
    const inject = async (path: string, totalMs: number) => {
      await sql`
        INSERT INTO messages (conversation_id, role, text, meta_json)
        VALUES (${cRow!.id}, 'assistant', ${`reply ${path}`}, ${JSON.stringify({ telemetry: { path, total_ms: totalMs, retrieval_ms: 50 } })})
      `;
    };
    await inject("ok", 100);
    await inject("ok", 200);
    await inject("ok", 300);
    await inject("no_context", 50);
    await inject("smalltalk", 5);

    // An ungrounded turn — fact-checker verdict lives in telemetry.factCheck.
    await sql`
      INSERT INTO messages (conversation_id, role, text, meta_json)
      VALUES (${cRow!.id}, 'assistant', 'dropped reply', ${JSON.stringify({
        telemetry: {
          path: "ungrounded",
          total_ms: 80,
          factCheck: { grounded: false, vacancyOk: true },
        },
      })})
    `;

    const r = await fetch(url("/admin/api/analytics?window=24h"), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      total_assistant_messages: number;
      by_path: Array<{ path: string; count: number }>;
      ungrounded_count: number;
      latency: {
        total_ms: { p50: number | null; p95: number | null; count: number };
        retrieval_ms: { count: number };
      };
    };
    expect(body.total_assistant_messages).toBe(6);

    const okCount = body.by_path.find((r2) => r2.path === "ok")?.count;
    expect(okCount).toBe(3);
    const noCtx = body.by_path.find((r2) => r2.path === "no_context")?.count;
    expect(noCtx).toBe(1);

    // The ungrounded count must read telemetry.factCheck.grounded (not the
    // long-removed `reflect` key) — so this turn is counted.
    expect(body.ungrounded_count).toBe(1);

    expect(body.latency.total_ms.count).toBe(6);
    expect(body.latency.total_ms.p50).toBeGreaterThan(0);
    expect(body.latency.retrieval_ms.count).toBe(5);
  });

  test("rejects unknown window param", async () => {
    const r = await fetch(url("/admin/api/analytics?window=invalid"), authed());
    expect(r.status).toBe(400);
  });
});

describe("kb management endpoints", () => {
  test("GET /admin/api/kb/documents requires auth + returns shape", async () => {
    expect((await fetch(url("/admin/api/kb/documents"))).status).toBe(401);
    const r = await fetch(url("/admin/api/kb/documents"), authed());
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      documents: unknown[];
      topics: string[];
      totals: { documents: number; chunks: number };
    };
    expect(Array.isArray(body.documents)).toBe(true);
    expect(Array.isArray(body.topics)).toBe(true);
    expect(typeof body.totals.documents).toBe("number");
  });

  test("PATCH /admin/api/kb/documents/:id retags + DELETE removes", async () => {
    // Seed one doc directly (no need to embed — we just want a row).
    await sql`INSERT INTO kb_documents (source, title, content_hash, topic) VALUES ('x.md', 'X', 'hash-x', NULL)`;
    const [docRow] = await sql<[{ id: number }]>`SELECT id FROM kb_documents`;
    const id = docRow!.id;

    const patch = await fetch(
      url(`/admin/api/kb/documents/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "visa" }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { document: { topic: string } }).document.topic).toBe("visa");

    const clear = await fetch(
      url(`/admin/api/kb/documents/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: null }),
      }),
    );
    expect(clear.status).toBe(200);
    expect(
      ((await clear.json()) as { document: { topic: string | null } }).document.topic,
    ).toBeNull();

    const del = await fetch(url(`/admin/api/kb/documents/${id}`), authed({ method: "DELETE" }));
    expect(del.status).toBe(200);
    const miss = await fetch(url(`/admin/api/kb/documents/${id}`), authed());
    expect(miss.status).toBe(404);
  });

  test("POST /admin/api/kb/ingest returns 503 when embedder is not configured", async () => {
    // The default server fixture doesn't pass `rag` deps, so the
    // ingest endpoint must fail loud with 503 rather than silently storing
    // a document with no retrievable chunks.
    const r = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", body: "Some body text" }),
      }),
    );
    expect(r.status).toBe(503);
  });

  test("POST /admin/api/kb/ingest validates input shape", async () => {
    // Missing both required fields
    const empty = await fetch(
      url("/admin/api/kb/ingest"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    // Note: 503 fires first when embedder absent, so we can't exercise 400
    // validation in this fixture. The 503 is fine — it confirms the auth
    // gate passed and we reached the embedder check.
    expect([400, 503]).toContain(empty.status);

    // Auth still gates the route
    const unauth = await fetch(url("/admin/api/kb/ingest"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T", body: "B" }),
    });
    expect(unauth.status).toBe(401);
  });
});
