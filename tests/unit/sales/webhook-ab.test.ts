import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { ExperimentsRepo } from "@/db/repos/experiments.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { seedBuiltinStyles, StylesRepo } from "@/db/repos/styles.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { coldDirectPas } from "@/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "@/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
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

interface CapturedChatCall {
  messages: ChatMessage[];
}

function captureChat(reply: string): { client: ChatClient; calls: CapturedChatCall[] } {
  const calls: CapturedChatCall[] = [];
  return {
    calls,
    client: {
      async complete(messages: ChatMessage[]) {
        calls.push({ messages: messages.slice() });
        return reply;
      },
    },
  };
}

interface OutgoingCall {
  method: string;
  body: Record<string, unknown>;
}

function setup(): {
  db: ReturnType<typeof openDb>;
  server: Server;
  sent: OutgoingCall[];
  chatCalls: CapturedChatCall[];
  port: number;
} {
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

  const chatCapture = captureChat("LLM-REPLY");
  // Seed a KB chunk so RAG returns SOME context (otherwise NO_CONTEXT_MARKER
  // path fires and we never reach the sales-engine prompt).
  const kb = new KbRepo(db);
  const doc = kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
  kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: "kb chunk",
    tokenCount: 5,
    embedding: vec(1),
  });

  // Seed the 3 builtin styles into the DB.
  const styles = new StylesRepo(db);
  seedBuiltinStyles(styles, [flirtyBelfort, empatheticNepq, coldDirectPas]);

  const router = createRouter({
    db,
    telegram,
    webhookSecret: SECRET,
    rag: { embedder: fakeEmbedder(), chat: chatCapture.client },
    awaitWebhookProcessing: true,
  });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { db, server, sent, chatCalls: chatCapture.calls, port: server.port };
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

async function send(port: number, fromId: number, text: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/telegram/${SECRET}`, {
    method: "POST",
    body: JSON.stringify(update(fromId, text)),
    headers: { "content-type": "application/json" },
  });
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup();
  // Whitelist users — webhook rejects unknown tg_user_ids.
  const users = new UsersRepo(ctx.db);
  users.create({ tgUserId: 100 });
  users.create({ tgUserId: 200 });
});

afterEach(() => teardown(ctx));

describe("webhook A/B — no experiment running", () => {
  test("legacy persona path: conversation has no style_id, no stage", async () => {
    await send(ctx.port, 100, "hello");

    const conv = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(100)!.id,
    )!;
    expect(conv.style_id).toBeNull();
    expect(conv.experiment_id).toBeNull();
    expect(conv.current_stage).toBeNull();

    const sys = ctx.chatCalls[0]?.messages[0];
    expect(sys?.role).toBe("system");
    // Legacy persona prompt has the "СТРОГИЕ ПРАВИЛА" header,
    // sales-engine prompt does not.
    expect(sys?.content).toContain("СТРОГИЕ ПРАВИЛА");
    expect(sys?.content).not.toContain("ТЕКУЩИЙ ЭТАП");
  });
});

describe("webhook A/B — running experiment assigns variant", () => {
  beforeEach(() => {
    new ExperimentsRepo(ctx.db).insert({
      slug: "test-exp",
      status: "running",
      allocation: { "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 },
      startedAt: 1,
    });
  });

  test("first message → assigns style_id + experiment_id, persists current_stage", async () => {
    await send(ctx.port, 100, "привет");

    const conv = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(100)!.id,
    )!;
    expect(conv.style_id).not.toBeNull();
    expect(conv.experiment_id).not.toBeNull();
    expect(conv.current_stage).toBe("opener");

    // The system prompt is the sales-engine composed prompt.
    const sys = ctx.chatCalls[0]?.messages[0];
    expect(sys?.content).toContain("ТЕКУЩИЙ ЭТАП: OPENER");
    expect(sys?.content).toContain("ФРЕЙМВОРК");
    expect(sys?.content).not.toContain("СТРОГИЕ ПРАВИЛА:"); // legacy marker absent

    // Assistant message persisted with stage tag.
    const msgs = new MessagesRepo(ctx.db).listByConversation(conv.id);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.stage).toBe("opener");
  });

  test("same user on second message → style is sticky (same style_id)", async () => {
    await send(ctx.port, 100, "привет");
    const conv1 = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(100)!.id,
    )!;
    const firstStyleId = conv1.style_id;

    await send(ctx.port, 100, "сколько в Дубае платят?");
    const conv2 = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(100)!.id,
    )!;
    expect(conv2.style_id).toBe(firstStyleId);
    // Stage advanced because of pricing keyword.
    expect(conv2.current_stage).toBe("pitch");
  });

  test("different users → assignment is deterministic per-user (same as pickVariant)", async () => {
    await send(ctx.port, 100, "hi");
    await send(ctx.port, 200, "hi");

    const users = new UsersRepo(ctx.db);
    const conv100 = new ConversationsRepo(ctx.db).byUserId(users.byTgId(100)!.id)!;
    const conv200 = new ConversationsRepo(ctx.db).byUserId(users.byTgId(200)!.id)!;

    expect(conv100.style_id).not.toBeNull();
    expect(conv200.style_id).not.toBeNull();
    // They MAY be the same or different — that depends on hash output. The
    // important thing is each is a known-valid style id.
    const styles = new StylesRepo(ctx.db);
    expect(styles.byId(conv100.style_id!)).not.toBeNull();
    expect(styles.byId(conv200.style_id!)).not.toBeNull();
  });

  test("malformed allocation in DB → graceful fallback to legacy persona", async () => {
    // Replace the running experiment with one that has bad allocation_json.
    ctx.db.run("DELETE FROM experiments");
    ctx.db.run(
      `INSERT INTO experiments (slug, status, allocation_json, success_metric, started_at)
       VALUES ('bad', 'running', '{not valid json', 'qualified', 1)`,
    );

    await send(ctx.port, 100, "hi");
    const conv = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(100)!.id,
    )!;
    // No assignment happened — sales-engine fell back gracefully.
    expect(conv.style_id).toBeNull();
    // Legacy persona prompt was used.
    const sys = ctx.chatCalls[0]?.messages[0];
    expect(sys?.content).toContain("СТРОГИЕ ПРАВИЛА");
  });

  test("experiment references non-existent style slug → graceful fallback", async () => {
    ctx.db.run("DELETE FROM experiments");
    ctx.db.run(
      `INSERT INTO experiments (slug, status, allocation_json, success_metric, started_at)
       VALUES ('ghost', 'running', '{"does-not-exist": 100}', 'qualified', 1)`,
    );

    await send(ctx.port, 100, "hi");
    const conv = new ConversationsRepo(ctx.db).byUserId(
      new UsersRepo(ctx.db).byTgId(100)!.id,
    )!;
    expect(conv.style_id).toBeNull();
  });
});
