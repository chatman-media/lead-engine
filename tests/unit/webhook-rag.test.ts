import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";

const SECRET = "test-secret";
const DIM = 1536;

function vec(seed: number): number[] {
  const arr = new Array<number>(DIM).fill(0);
  arr[seed % DIM] = 1;
  return arr;
}

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map((t) => vec(t.length));
    },
  };
}

function fakeChat(reply: string): ChatClient {
  return {
    async complete(_messages: ChatMessage[]) {
      return reply;
    },
  };
}

interface OutgoingCall {
  method: string;
  body: Record<string, unknown>;
}

function setup(opts: {
  embedder: EmbeddingClient;
  chat: ChatClient;
  persona?: { name: string; role: "human" | "assistant"; company?: string };
  /** When provided, lets a test count how many times the LLM was called. */
  chatCallCounter?: { count: number };
}) {
  const db = openDb({ path: ":memory:", embeddingDim: DIM });
  const sent: OutgoingCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const apiMethod = url.split("/").pop() ?? "";
    const body = JSON.parse((init?.body as string) ?? "{}");
    sent.push({ method: apiMethod, body });
    const result =
      apiMethod === "sendMessage"
        ? {
            message_id: Math.floor(Math.random() * 1_000_000),
            chat: { id: body.chat_id, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: body.text,
          }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    db,
    telegram,
    webhookSecret: SECRET,
    rag: {
      embedder: opts.embedder,
      chat: opts.chat,
      ...(opts.persona ? { persona: opts.persona } : {}),
    },
    // Tests need deterministic post-conditions; production uses
    // fire-and-forget so the Telegram ack stays under 60s.
    awaitWebhookProcessing: true,
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req) => router.handle(req),
  });
  return { db, router, server, sent };
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

function update(fromId: number, text: string): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat: { id: fromId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup({ embedder: fakeEmbedder(), chat: fakeChat("From RAG") });
});

afterEach(() => teardown(ctx));

describe("webhook RAG integration", () => {
  test("ai mode + KB has context: replies with RAG answer (not placeholder)", async () => {
    const users = new UsersRepo(ctx.db);
    const kb = new KbRepo(ctx.db);
    const u = users.create({ tgUserId: 100 });
    const doc = kb.upsertDocument({
      source: "s://t",
      title: "doc",
      contentHash: "h",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "Some KB text",
      tokenCount: 5,
      embedding: vec(7),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(100, "any question")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.body.text).toBe("From RAG");

    const msgs = new MessagesRepo(ctx.db).listByConversation(
      new ConversationsRepo(ctx.db).byUserId(u.id)!.id,
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.text).toBe("From RAG");
  });

  test("ai mode + LLM returns NO_CONTEXT_MARKER: switches to queued, no Telegram message", async () => {
    teardown(ctx);
    ctx = setup({
      embedder: fakeEmbedder(),
      chat: fakeChat("__NO_CONTEXT__"),
    });
    const users = new UsersRepo(ctx.db);
    const kb = new KbRepo(ctx.db);
    const u = users.create({ tgUserId: 200 });
    const doc = kb.upsertDocument({
      source: "s://t",
      title: "doc",
      contentHash: "h",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "irrelevant",
      tokenCount: 3,
      embedding: vec(1),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(200, "off-topic question")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    expect(ctx.sent).toHaveLength(0);

    const conv = new ConversationsRepo(ctx.db).byUserId(u.id)!;
    expect(conv.mode).toBe("queued");
  });

  test("two NO_CONTEXT in ai: no Telegram traffic, mode queued after first", async () => {
    teardown(ctx);
    ctx = setup({
      embedder: fakeEmbedder(),
      chat: fakeChat("__NO_CONTEXT__"),
    });
    const users = new UsersRepo(ctx.db);
    const kb = new KbRepo(ctx.db);
    const u = users.create({ tgUserId: 420 });
    const doc = kb.upsertDocument({
      source: "s://t",
      title: "doc",
      contentHash: "h",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "irrelevant",
      tokenCount: 3,
      embedding: vec(1),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(420, "off-topic")),
      headers: { "content-type": "application/json" },
    });
    expect(ctx.sent).toHaveLength(0);

    await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(420, "still-off-topic")),
      headers: { "content-type": "application/json" },
    });
    expect(ctx.sent).toHaveLength(0);
    expect(new ConversationsRepo(ctx.db).byUserId(u.id)!.mode).toBe("queued");
  });

  test("ai mode: NO_CONTEXT then on-topic question gets RAG reply", async () => {
    teardown(ctx);
    let turn = 0;
    ctx = setup({
      embedder: fakeEmbedder(),
      chat: {
        async complete() {
          turn++;
          return turn === 1 ? "__NO_CONTEXT__" : "Ответ из базы после очереди";
        },
      },
    });
    const users = new UsersRepo(ctx.db);
    const kb = new KbRepo(ctx.db);
    const u = users.create({ tgUserId: 500 });
    const doc = kb.upsertDocument({
      source: "s://t",
      title: "vacancy-china",
      contentHash: "h2",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "Вакансии в Китае: подробности в контексте.",
      tokenCount: 8,
      embedding: vec(3),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(500, "про рыбалку")),
      headers: { "content-type": "application/json" },
    });
    await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(500, "работа в Китае?")),
      headers: { "content-type": "application/json" },
    });

    expect(ctx.sent).toHaveLength(1);
    expect(String(ctx.sent[0]!.body.text)).toBe("Ответ из базы после очереди");
    const conv = new ConversationsRepo(ctx.db).byUserId(u.id)!;
    expect(conv.mode).toBe("ai");
  });

  test("kb empty: silent, queued for operator", async () => {
    const users = new UsersRepo(ctx.db);
    users.create({ tgUserId: 300 });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(300, "anything")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const conv = new ConversationsRepo(ctx.db).byUserId(new UsersRepo(ctx.db).byTgId(300)!.id)!;
    expect(conv.mode).toBe("queued");
    expect(ctx.sent).toHaveLength(0);
  });
  test("ai mode + smalltalk question: replies with persona name, LLM not called", async () => {
    teardown(ctx);
    let chatCalls = 0;
    ctx = setup({
      embedder: fakeEmbedder(),
      chat: {
        async complete() {
          chatCalls++;
          return "should-never-be-sent";
        },
      },
      persona: {
        name: "Алина",
        role: "human",
        company: "INFINITY AGENCY",
      },
    });
    const users = new UsersRepo(ctx.db);
    const kb = new KbRepo(ctx.db);
    const u = users.create({ tgUserId: 700 });
    // Seed a KB chunk so the search step has something — proves the
    // shortcut runs BEFORE retrieval and bypasses both.
    const doc = kb.upsertDocument({ source: "s", title: "doc", contentHash: "h" });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "irrelevant filler",
      tokenCount: 3,
      embedding: vec(99),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    for (const text of ["как зовут?", "имя?", "представься", "кто ты?"]) {
      const res = await fetch(url, {
        method: "POST",
        body: JSON.stringify(update(700, text)),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
    }

    // Four user messages → four replies, none from the LLM.
    expect(ctx.sent).toHaveLength(4);
    expect(chatCalls).toBe(0);
    for (const call of ctx.sent) {
      const text = String(call.body.text);
      expect(text).toContain("Алина");
      expect(text).toContain("INFINITY AGENCY");
      // Conversation must NOT be queued — smalltalk replies don't escalate.
    }
    const conv = new ConversationsRepo(ctx.db).byUserId(u.id)!;
    expect(conv.mode).toBe("ai");
  });

  // Regression: webhook used to call answerWithRag without `history`, so each
  // turn was isolated. Real conversation broke at "все" / "расскажи подробнее"
  // because model didn't see prior turns. Now we read recentForContext()
  // and pass last 12 messages — assistant answers stay coherent across turns.
  test("multi-turn: history is passed to LLM (chat receives prior messages)", async () => {
    teardown(ctx);
    const captured: ChatMessage[][] = [];
    const captureChat: ChatClient = {
      async complete(messages) {
        captured.push(messages.slice());
        return "Ok-reply";
      },
    };
    ctx = setup({
      embedder: fakeEmbedder(),
      chat: captureChat,
    });
    const users = new UsersRepo(ctx.db);
    const kb = new KbRepo(ctx.db);
    const _u = users.create({ tgUserId: 800 });
    const doc = kb.upsertDocument({
      source: "s://t",
      title: "doc",
      contentHash: "h",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "Some KB text about jobs",
      tokenCount: 5,
      embedding: vec(7),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    // Three turns; the 3rd LLM call must see turns 1+2 as history.
    for (const text of ["привет", "расскажи про работу", "а условия?"]) {
      await fetch(url, {
        method: "POST",
        body: JSON.stringify(update(800, text)),
        headers: { "content-type": "application/json" },
      });
    }

    expect(captured).toHaveLength(3);
    const thirdCall = captured[2]!;
    // Shape: [system, ...history, user]. history must include turns 1+2.
    expect(thirdCall[0]?.role).toBe("system");
    const tail = thirdCall[thirdCall.length - 1];
    expect(tail?.role).toBe("user");
    expect(tail?.content).toBe("а условия?");
    // History sandwich (everything between system and final user) MUST contain
    // both prior user messages + their assistant replies.
    const sandwich = thirdCall.slice(1, -1);
    const sandwichTexts = sandwich.map((m) => m.content);
    expect(sandwichTexts).toContain("привет");
    expect(sandwichTexts).toContain("расскажи про работу");
    // And the assistant replies persisted from prior turns:
    expect(sandwichTexts.filter((t) => t === "Ok-reply").length).toBeGreaterThanOrEqual(2);
    // The current-turn user message must NOT also appear in the sandwich
    // (would mean we forgot to dedupe the just-inserted row).
    expect(sandwichTexts).not.toContain("а условия?");
  });
});
