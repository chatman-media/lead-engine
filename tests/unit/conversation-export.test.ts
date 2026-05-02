import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { ExperimentsRepo } from "@/db/repos/experiments.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { seedBuiltinStyles, StylesRepo } from "@/db/repos/styles.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import { coldDirectPas } from "@/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "@/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
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
  const login = await fetch(
    `http://127.0.0.1:${ctx.server.port}/admin/api/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
    },
  );
  const set = login.headers.get("set-cookie")!;
  cookie = set.split(";")[0]!;
}, 30_000);
afterEach(() => teardown(ctx));

function url(path: string) {
  return `http://127.0.0.1:${ctx.server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { ...(extra.headers ?? {}), cookie } };
}

/** Seed a single conversation with a few exchanges. */
function seedConversation(opts: {
  tgUserId: number;
  status?: string;
  styleSlug?: string;
  experimentId?: number;
  stage?: string;
  mode?: "ai" | "queued" | "human";
  exchanges: Array<{ user: string; assistant: string; stage?: string }>;
}): number {
  const users = new UsersRepo(ctx.db);
  const conversations = new ConversationsRepo(ctx.db);
  const messages = new MessagesRepo(ctx.db);
  const styles = new StylesRepo(ctx.db);

  const u = users.create({
    tgUserId: opts.tgUserId,
    tgUsername: `u${opts.tgUserId}`,
    status: opts.status ?? "new",
  });
  const conv = conversations.ensureForUser(u.id);

  if (opts.styleSlug) {
    const style = styles.bySlug(opts.styleSlug);
    if (style) {
      conversations.assignStyle(conv.id, style.id, opts.experimentId ?? null);
    }
  }
  if (opts.stage) conversations.setCurrentStage(conv.id, opts.stage);
  if (opts.mode && opts.mode !== "ai") conversations.setMode(conv.id, opts.mode);

  for (const ex of opts.exchanges) {
    messages.add({
      conversationId: conv.id,
      role: "user",
      text: ex.user,
      ...(ex.stage ? { stage: ex.stage } : {}),
    });
    messages.add({
      conversationId: conv.id,
      role: "assistant",
      text: ex.assistant,
      ...(ex.stage ? { stage: ex.stage } : {}),
    });
  }

  return conv.id;
}

interface ExportedTurn {
  role: string;
  content: string;
  stage?: string | null;
}
interface ExportedConv {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  user_status: string | null;
  mode: string;
  style_slug: string | null;
  experiment_slug: string | null;
  current_stage: string | null;
  messages: ExportedTurn[];
}

function parseJsonl(text: string): ExportedConv[] {
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ExportedConv);
}

describe("GET /admin/api/conversations/:id/export.jsonl", () => {
  test("requires auth", async () => {
    const id = seedConversation({
      tgUserId: 100,
      exchanges: [{ user: "hi", assistant: "yo" }],
    });
    const res = await fetch(url(`/admin/api/conversations/${id}/export.jsonl`));
    expect(res.status).toBe(401);
  });

  test("happy path: returns one JSONL line with all messages oldest-first", async () => {
    const id = seedConversation({
      tgUserId: 100,
      status: "qualified",
      exchanges: [
        { user: "привет", assistant: "ахуенно смотришься, кто ты?" },
        { user: "Аня, 24", assistant: "круто, расскажи про опыт" },
      ],
    });
    const res = await fetch(
      url(`/admin/api/conversations/${id}/export.jsonl`),
      authed(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/jsonl");
    expect(res.headers.get("content-disposition")).toContain(
      `filename="conversation-${id}.jsonl"`,
    );
    expect(res.headers.get("x-export-count")).toBe("1");

    const body = await res.text();
    const parsed = parseJsonl(body);
    expect(parsed.length).toBe(1);
    const conv = parsed[0]!;
    expect(conv.id).toBe(id);
    expect(conv.tg_user_id).toBe(100);
    expect(conv.user_status).toBe("qualified");
    expect(conv.messages.length).toBe(4);
    // Oldest-first: user1, assistant1, user2, assistant2.
    expect(conv.messages[0]).toMatchObject({ role: "user", content: "привет" });
    expect(conv.messages[1]).toMatchObject({
      role: "assistant",
      content: "ахуенно смотришься, кто ты?",
    });
    expect(conv.messages[3]).toMatchObject({
      role: "assistant",
      content: "круто, расскажи про опыт",
    });
  });

  test("includes style_slug and experiment_slug when conversation is assigned", async () => {
    seedBuiltinStyles(new StylesRepo(ctx.db), [flirtyBelfort]);
    const exp = new ExperimentsRepo(ctx.db).insert({
      slug: "april-test",
      status: "running",
      allocation: { "flirty-belfort-v1": 100 },
    });
    const id = seedConversation({
      tgUserId: 200,
      styleSlug: "flirty-belfort-v1",
      experimentId: exp.id,
      stage: "qualify",
      exchanges: [{ user: "hi", assistant: "yo", stage: "opener" }],
    });
    const res = await fetch(
      url(`/admin/api/conversations/${id}/export.jsonl`),
      authed(),
    );
    const conv = parseJsonl(await res.text())[0]!;
    expect(conv.style_slug).toBe("flirty-belfort-v1");
    expect(conv.experiment_slug).toBe("april-test");
    expect(conv.current_stage).toBe("qualify");
    expect(conv.messages[0]?.stage).toBe("opener");
  });

  test("404 for unknown id", async () => {
    const res = await fetch(
      url("/admin/api/conversations/9999/export.jsonl"),
      authed(),
    );
    expect(res.status).toBe(404);
  });

  test("400 for non-numeric id", async () => {
    const res = await fetch(
      url("/admin/api/conversations/abc/export.jsonl"),
      authed(),
    );
    expect(res.status).toBe(400);
  });

  test("conversation with no messages is exported with empty messages[]", async () => {
    const id = seedConversation({ tgUserId: 300, exchanges: [] });
    const res = await fetch(
      url(`/admin/api/conversations/${id}/export.jsonl`),
      authed(),
    );
    const conv = parseJsonl(await res.text())[0]!;
    expect(conv.messages).toEqual([]);
  });
});

describe("GET /admin/api/conversations/export.jsonl (bulk)", () => {
  beforeEach(() => {
    seedBuiltinStyles(new StylesRepo(ctx.db), [
      flirtyBelfort,
      empatheticNepq,
      coldDirectPas,
    ]);
  });

  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/conversations/export.jsonl"));
    expect(res.status).toBe(401);
  });

  test("returns ALL conversations when no filters set", async () => {
    seedConversation({
      tgUserId: 1,
      exchanges: [{ user: "hi", assistant: "yo" }],
    });
    seedConversation({
      tgUserId: 2,
      exchanges: [{ user: "ku", assistant: "ka" }],
    });
    const res = await fetch(
      url("/admin/api/conversations/export.jsonl"),
      authed(),
    );
    expect(res.status).toBe(200);
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.tg_user_id).sort()).toEqual([1, 2]);
  });

  test("filter by style_id", async () => {
    const flirty = new StylesRepo(ctx.db).bySlug("flirty-belfort-v1")!;
    const empath = new StylesRepo(ctx.db).bySlug("empathetic-nepq-v1")!;
    seedConversation({
      tgUserId: 10,
      styleSlug: "flirty-belfort-v1",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    seedConversation({
      tgUserId: 20,
      styleSlug: "empathetic-nepq-v1",
      exchanges: [{ user: "a", assistant: "b" }],
    });

    const res = await fetch(
      url(`/admin/api/conversations/export.jsonl?style_id=${flirty.id}`),
      authed(),
    );
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(1);
    expect(lines[0]!.tg_user_id).toBe(10);
    expect(lines[0]!.style_slug).toBe("flirty-belfort-v1");
    // Sanity: the other style was seeded but excluded.
    expect(empath).not.toBeNull();
  });

  test("filter by experiment_id", async () => {
    const exp = new ExperimentsRepo(ctx.db).insert({
      slug: "exp-1",
      status: "running",
      allocation: { "flirty-belfort-v1": 100 },
    });
    seedConversation({
      tgUserId: 50,
      styleSlug: "flirty-belfort-v1",
      experimentId: exp.id,
      exchanges: [{ user: "a", assistant: "b" }],
    });
    seedConversation({
      tgUserId: 51,
      exchanges: [{ user: "a", assistant: "b" }],
    });
    const res = await fetch(
      url(`/admin/api/conversations/export.jsonl?experiment_id=${exp.id}`),
      authed(),
    );
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(1);
    expect(lines[0]!.tg_user_id).toBe(50);
    expect(lines[0]!.experiment_slug).toBe("exp-1");
  });

  test("filter by user_status", async () => {
    seedConversation({
      tgUserId: 70,
      status: "qualified",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    seedConversation({
      tgUserId: 71,
      status: "lost",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    const res = await fetch(
      url("/admin/api/conversations/export.jsonl?user_status=qualified"),
      authed(),
    );
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(1);
    expect(lines[0]!.tg_user_id).toBe(70);
    expect(lines[0]!.user_status).toBe("qualified");
  });

  test("filter by mode", async () => {
    seedConversation({
      tgUserId: 80,
      mode: "human",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    seedConversation({
      tgUserId: 81,
      mode: "ai",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    const res = await fetch(
      url("/admin/api/conversations/export.jsonl?mode=human"),
      authed(),
    );
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(1);
    expect(lines[0]!.tg_user_id).toBe(80);
    expect(lines[0]!.mode).toBe("human");
  });

  test("limit param caps the number of rows", async () => {
    for (let i = 0; i < 5; i++) {
      seedConversation({
        tgUserId: 1000 + i,
        exchanges: [{ user: "a", assistant: "b" }],
      });
    }
    const res = await fetch(
      url("/admin/api/conversations/export.jsonl?limit=2"),
      authed(),
    );
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(2);
  });

  test("limit is clamped to the hard maximum", async () => {
    // Just verify the request doesn't error with a giant limit; we don't
    // actually create thousands of conversations in the test.
    seedConversation({
      tgUserId: 9999,
      exchanges: [{ user: "a", assistant: "b" }],
    });
    const res = await fetch(
      url("/admin/api/conversations/export.jsonl?limit=99999"),
      authed(),
    );
    expect(res.status).toBe(200);
  });

  test("non-numeric limit is ignored (falls back to default)", async () => {
    seedConversation({
      tgUserId: 5000,
      exchanges: [{ user: "a", assistant: "b" }],
    });
    const res = await fetch(
      url("/admin/api/conversations/export.jsonl?limit=abc"),
      authed(),
    );
    expect(res.status).toBe(200);
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(1);
  });

  test("empty result returns 200 with empty body and count=0", async () => {
    const res = await fetch(
      url(`/admin/api/conversations/export.jsonl?style_id=99999`),
      authed(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-export-count")).toBe("0");
    expect((await res.text()).trim()).toBe("");
  });

  test("multiple filters combine (AND semantics)", async () => {
    seedConversation({
      tgUserId: 200,
      status: "qualified",
      styleSlug: "flirty-belfort-v1",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    seedConversation({
      tgUserId: 201,
      status: "lost",
      styleSlug: "flirty-belfort-v1",
      exchanges: [{ user: "a", assistant: "b" }],
    });
    seedConversation({
      tgUserId: 202,
      status: "qualified",
      styleSlug: "empathetic-nepq-v1",
      exchanges: [{ user: "a", assistant: "b" }],
    });

    const flirty = new StylesRepo(ctx.db).bySlug("flirty-belfort-v1")!;
    const res = await fetch(
      url(
        `/admin/api/conversations/export.jsonl?style_id=${flirty.id}&user_status=qualified`,
      ),
      authed(),
    );
    const lines = parseJsonl(await res.text());
    expect(lines.length).toBe(1);
    expect(lines[0]!.tg_user_id).toBe(200);
  });
});
