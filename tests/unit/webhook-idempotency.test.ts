import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";
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

function setup() {
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
            message_id: 9000 + sent.length,
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
    rag: { embedder: fakeEmbedder(), chat: fakeChat("Привет от бота") },
    awaitWebhookProcessing: true,
  });
  const server = Bun.serve({
    port: 0,
    fetch: (req) => router.handle(req),
  });
  return { db, server, sent };
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

/** Same update_id + same message_id, replayed verbatim — exactly what
 *  Bot API does when our handler doesn't ack within ~60s. */
function fixedUpdate(fromId: number, messageId: number, text: string): TgUpdate {
  return {
    update_id: 777_000 + messageId,
    message: {
      message_id: messageId,
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat: { id: fromId, type: "private" },
      date: 1_700_000_000,
      text,
    },
  };
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup();
});

afterEach(() => teardown(ctx));

describe("webhook idempotency (Telegram retry hardening)", () => {
  test("replaying the same update twice persists one user-msg and triggers one assistant reply", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 555 });

    // KB seed so RAG actually has a context to answer from (otherwise
    // the second branch would escalate and we'd be measuring the wrong
    // thing).
    const { KbRepo } = await import("@/db/repos/kb.ts");
    const kb = new KbRepo(ctx.db);
    const doc = kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "anything",
      tokenCount: 1,
      embedding: vec(7),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const update = fixedUpdate(555, 42, "первое сообщение");
    const init = {
      method: "POST",
      body: JSON.stringify(update),
      headers: { "content-type": "application/json" },
    };

    const r1 = await fetch(url, init);
    const r2 = await fetch(url, init);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const body2 = (await r2.json()) as { ok: boolean; deduped?: boolean };
    expect(body2.deduped).toBe(true);

    const conv = new ConversationsRepo(ctx.db).byUserId(u.id);
    expect(conv).not.toBeNull();
    const msgs = new MessagesRepo(ctx.db).listByConversation(conv!.id);

    const userRows = msgs.filter((m) => m.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.tg_message_id).toBe(42);

    const assistantRows = msgs.filter((m) => m.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.text).toBe("Привет от бота");

    const sendCalls = ctx.sent.filter((c) => c.method === "sendMessage");
    expect(sendCalls).toHaveLength(1);
  });

  test("a different message_id from the same user is NOT deduped", async () => {
    const users = new UsersRepo(ctx.db);
    const u = users.create({ tgUserId: 556 });

    const { KbRepo } = await import("@/db/repos/kb.ts");
    const kb = new KbRepo(ctx.db);
    const doc = kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "anything",
      tokenCount: 1,
      embedding: vec(7),
    });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const post = (mid: number, text: string) =>
      fetch(url, {
        method: "POST",
        body: JSON.stringify(fixedUpdate(556, mid, text)),
        headers: { "content-type": "application/json" },
      });

    await post(1, "первое");
    await post(2, "второе");

    const conv = new ConversationsRepo(ctx.db).byUserId(u.id)!;
    const userRows = new MessagesRepo(ctx.db)
      .listByConversation(conv.id)
      .filter((m) => m.role === "user");
    expect(userRows).toHaveLength(2);
    expect(userRows.map((r) => r.tg_message_id).sort()).toEqual([1, 2]);
  });
});
