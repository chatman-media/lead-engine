// A bare photo/media upload (no text caption) is a "media-only turn":
// the bot must NOT generate a chat reply for it — a photo is not a
// question — it only persists + classifies the photo and (with vision on)
// sends one deduped acknowledgement per album. This guards the
// `mediaOnly` branch in processInbound shared by the webhook + userbot.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import type { ChatClient } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "test-secret";
const DIM = 8;

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map(() => new Array<number>(DIM).fill(0));
    },
  };
}

function fakeChat(reply: string): ChatClient {
  return {
    async complete() {
      return reply;
    },
  };
}

let server: Server;
let sent: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  sent = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const apiMethod = url.split("/").pop() ?? "";
    const body = JSON.parse((init?.body as string) ?? "{}");
    sent.push({ method: apiMethod, body });
    return new Response(
      JSON.stringify({
        ok: true,
        result:
          apiMethod === "sendMessage"
            ? { message_id: Math.floor(Math.random() * 1e6), chat: {}, date: 0, text: body.text }
            : true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    rag: { embedder: fakeEmbedder(), chat: fakeChat("RAG REPLY") },
    awaitWebhookProcessing: true,
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
});

afterEach(() => server.stop(true));

function photoUpdate(fromId: number): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat: { id: fromId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      photo: [
        { file_id: "ph-s", file_unique_id: "pu-s", width: 90, height: 120 },
        { file_id: "ph-l", file_unique_id: "pu-l", width: 800, height: 1200 },
      ],
    },
  };
}

describe("media-only turn (bare photo)", () => {
  test("a bare photo is persisted but draws no chat reply", async () => {
    const u = await new UsersRepo(sql).create({ tgUserId: 8001 });

    const res = await fetch(`http://127.0.0.1:${server.port}/telegram/${SECRET}`, {
      method: "POST",
      body: JSON.stringify(photoUpdate(8001)),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);

    // A photo is not a question — no RAG chat reply is sent. (Vision is off
    // in tests, so there's no passport/full-body acknowledgement either.)
    expect(sent.filter((c) => c.method === "sendMessage")).toHaveLength(0);

    // …but the photo IS persisted with its media metadata, so the SQL
    // intake counters and (when enabled) classification can see it.
    const conv = (await new ConversationsRepo(sql).byUserId(u.id))!;
    const msgs = await new MessagesRepo(sql).listByConversation(conv.id);
    const photo = msgs.find((m) => m.text === "[photo]");
    expect(photo).toBeDefined();
    expect(JSON.parse(photo!.meta_json ?? "{}").media?.type).toBe("photo");
  });
});
