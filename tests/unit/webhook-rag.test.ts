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
import {
  TelegramClient,
  type FetchLike,
} from "@/telegram/client.ts";
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
    rag: { embedder: opts.embedder, chat: opts.chat },
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
  ctx = setup({ embedder: fakeEmbedder(), chat: fakeChat("from RAG") });
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
    expect(ctx.sent[0]!.body.text).toBe("from RAG");

    const msgs = new MessagesRepo(ctx.db).listByConversation(
      new ConversationsRepo(ctx.db).byUserId(u.id)!.id,
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.text).toBe("from RAG");
  });

  test("ai mode + LLM returns NO_CONTEXT_MARKER: escalates to queued, no answer sent", async () => {
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

    expect(ctx.sent).toHaveLength(1);
    expect(String(ctx.sent[0]!.body.text)).toMatch(/оператор|operator/i);

    const conv = new ConversationsRepo(ctx.db).byUserId(u.id)!;
    expect(conv.mode).toBe("queued");
  });

  test("ai mode + KB empty: escalates to queued, no LLM answer", async () => {
    const users = new UsersRepo(ctx.db);
    users.create({ tgUserId: 300 });

    const url = `http://127.0.0.1:${ctx.server.port}/telegram/${SECRET}`;
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(update(300, "anything")),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const conv = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(300)!.id,
    )!;
    expect(conv.mode).toBe("queued");
  });
});
