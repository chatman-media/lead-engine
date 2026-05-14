import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { ExperimentsRepo } from "@/db/repos/experiments.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { StylesRepo, seedBuiltinStyles } from "@/db/repos/styles.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { coldDirectPas } from "@/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "@/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../../helpers/test-db.ts";

const SECRET = "test-secret";
const DIM = 8;

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

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

function buildFetchImpl(): { fetchImpl: FetchLike; sent: OutgoingCall[] } {
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
  return { fetchImpl, sent };
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

let server: Server;
let chatCalls: CapturedChatCall[];
let port: number;

beforeEach(async () => {
  const { fetchImpl, sent: _ } = buildFetchImpl();
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });

  const chatCapture = captureChat("LLM-REPLY");
  chatCalls = chatCapture.calls;

  // Seed a KB chunk so RAG returns SOME context (otherwise NO_CONTEXT_MARKER
  // path fires and we never reach the sales-engine prompt).
  const kb = new KbRepo(sql);
  const doc = await kb.upsertDocument({ source: "s", title: "t", contentHash: "h" });
  await kb.insertChunkWithEmbedding({
    documentId: doc.id,
    chunkIndex: 0,
    text: "kb chunk",
    tokenCount: 5,
    embedding: vec(1),
  });

  // Seed the 3 builtin styles into the DB.
  const styles = new StylesRepo(sql);
  await seedBuiltinStyles(styles, [flirtyBelfort, empatheticNepq, coldDirectPas]);

  const router = createRouter({
    sql,
    telegram,
    webhookSecret: SECRET,
    rag: { embedder: fakeEmbedder(), chat: chatCapture.client },
    awaitWebhookProcessing: true,
  });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  port = server.port;

  // Whitelist users — webhook rejects unknown tg_user_ids.
  const users = new UsersRepo(sql);
  await users.create({ tgUserId: 100 });
  await users.create({ tgUserId: 200 });
});

afterEach(() => {
  server.stop(true);
});

describe("webhook A/B — no experiment running", () => {
  test("legacy persona path: conversation has no style_id, no stage", async () => {
    await send(port, 100, "hello");

    const user = await new UsersRepo(sql).byTgId(100);
    const conv = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    expect(conv.style_id).toBeNull();
    expect(conv.experiment_id).toBeNull();
    expect(conv.current_stage).toBeNull();

    const sys = chatCalls[0]?.messages[0];
    expect(sys?.role).toBe("system");
    // Legacy persona prompt has the "СТРОГИЕ ПРАВИЛА" header,
    // sales-engine prompt does not.
    expect(sys?.content).toContain("СТРОГИЕ ПРАВИЛА");
    expect(sys?.content).not.toContain("ТЕКУЩИЙ ЭТАП");
  });
});

describe("webhook with LLM stage classifier enabled", () => {
  // Spin up a parallel server on the same DB but with stageClassifier="llm".
  // The chat client routes by system-prompt content: the classifier's
  // system prompt starts with "Ты — классификатор", actual answer prompts
  // start with persona blocks ("Тебя зовут ..."). This lets us return
  // different JSON / text per call without spinning up two clients.
  let llmServer: Server;
  let classifierCalls: ChatMessage[][];
  let answerCalls: ChatMessage[][];

  beforeEach(async () => {
    // Ensure flirty-belfort is in DB (already seeded in outer beforeEach,
    // but add experiment to run against it).
    await new ExperimentsRepo(sql).insert({
      slug: "classifier-test",
      status: "running",
      allocation: { "flirty-belfort-v1": 100 },
      startedAt: 1,
    });

    classifierCalls = [];
    answerCalls = [];

    const routedChat: ChatClient = {
      async complete(messages: ChatMessage[]) {
        const sys = messages[0]?.content ?? "";
        if (sys.includes("классификатор этапов")) {
          classifierCalls.push(messages.slice());
          return '{"stage": "objection", "confidence": 0.92}';
        }
        answerCalls.push(messages.slice());
        return "LLM-REPLY";
      },
    };

    const { fetchImpl } = buildFetchImpl();
    const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });

    const router = createRouter({
      sql,
      telegram,
      webhookSecret: SECRET,
      rag: {
        embedder: fakeEmbedder(),
        chat: routedChat,
        stageClassifier: "llm",
      },
      awaitWebhookProcessing: true,
    });
    llmServer = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  });

  afterEach(() => {
    llmServer.stop(true);
  });

  test("classifier IS called and its stage decision wins over regex", async () => {
    // Message: "сколько в Дубае платят?" — regex would route to "pitch".
    // Classifier (mocked) returns "objection" with confidence 0.92.
    // The LLM result should win.
    await fetch(`http://127.0.0.1:${llmServer.port}/telegram/${SECRET}`, {
      method: "POST",
      body: JSON.stringify(update(100, "сколько в Дубае платят?")),
      headers: { "content-type": "application/json" },
    });

    expect(classifierCalls.length).toBe(1);
    expect(answerCalls.length).toBe(1);

    const user = await new UsersRepo(sql).byTgId(100);
    const conv = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    expect(conv.current_stage).toBe("objection"); // LLM, not regex's "pitch"

    // The actual answer prompt was built for the LLM-classified stage.
    const answerSys = answerCalls[0]?.[0]?.content ?? "";
    expect(answerSys).toContain("ТЕКУЩИЙ ЭТАП: OBJECTION");
  });

  test("classifier sees the full message + previous stage", async () => {
    // Send two messages so the second one has a previous stage to reference.
    await fetch(`http://127.0.0.1:${llmServer.port}/telegram/${SECRET}`, {
      method: "POST",
      body: JSON.stringify(update(100, "первое сообщение")),
      headers: { "content-type": "application/json" },
    });
    classifierCalls = []; // reset for the second call
    await fetch(`http://127.0.0.1:${llmServer.port}/telegram/${SECRET}`, {
      method: "POST",
      body: JSON.stringify(update(100, "второе сообщение про деньги")),
      headers: { "content-type": "application/json" },
    });

    expect(classifierCalls.length).toBe(1);
    const userPrompt = classifierCalls[0]![1]!.content;
    expect(userPrompt).toContain("второе сообщение про деньги");
    expect(userPrompt).toContain("objection"); // the previous stage we set
  });
});

describe("webhook A/B — running experiment assigns variant", () => {
  beforeEach(async () => {
    await new ExperimentsRepo(sql).insert({
      slug: "test-exp",
      status: "running",
      allocation: { "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 },
      startedAt: 1,
    });
  });

  test("first message → assigns style_id + experiment_id, persists current_stage", async () => {
    await send(port, 100, "привет");

    const user = await new UsersRepo(sql).byTgId(100);
    const conv = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    expect(conv.style_id).not.toBeNull();
    expect(conv.experiment_id).not.toBeNull();
    expect(conv.current_stage).toBe("opener");

    // The system prompt is the sales-engine composed prompt.
    const sys = chatCalls[0]?.messages[0];
    expect(sys?.content).toContain("ТЕКУЩИЙ ЭТАП: OPENER");
    expect(sys?.content).toContain("ФРЕЙМВОРК");
    expect(sys?.content).not.toContain("СТРОГИЕ ПРАВИЛА:"); // legacy marker absent

    // Assistant message persisted with stage tag.
    const msgs = await new MessagesRepo(sql).listByConversation(conv.id);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.stage).toBe("opener");
  });

  test("same user on second message → style is sticky (same style_id)", async () => {
    await send(port, 100, "привет");
    const user = await new UsersRepo(sql).byTgId(100);
    const conv1 = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    const firstStyleId = conv1.style_id;

    await send(port, 100, "сколько в Дубае платят?");
    const conv2 = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    expect(conv2.style_id).toBe(firstStyleId);
    // Stage advanced because of pricing keyword.
    expect(conv2.current_stage).toBe("pitch");
  });

  test("different users → assignment is deterministic per-user (same as pickVariant)", async () => {
    await send(port, 100, "hi");
    await send(port, 200, "hi");

    const users = new UsersRepo(sql);
    const u100 = await users.byTgId(100);
    const u200 = await users.byTgId(200);
    const conv100 = (await new ConversationsRepo(sql).byUserId(u100!.id))!;
    const conv200 = (await new ConversationsRepo(sql).byUserId(u200!.id))!;

    expect(conv100.style_id).not.toBeNull();
    expect(conv200.style_id).not.toBeNull();
    // They MAY be the same or different — that depends on hash output. The
    // important thing is each is a known-valid style id.
    const styles = new StylesRepo(sql);
    expect(await styles.byId(conv100.style_id!)).not.toBeNull();
    expect(await styles.byId(conv200.style_id!)).not.toBeNull();
  });

  test("malformed allocation in DB → graceful fallback to legacy persona", async () => {
    // Replace the running experiment with one that has bad allocation_json.
    await sql`DELETE FROM experiments`;
    await sql`
      INSERT INTO experiments (slug, status, allocation_json, success_metric, started_at)
      VALUES ('bad', 'running', '{not valid json', 'qualified', 1)
    `;

    await send(port, 100, "hi");
    const user = await new UsersRepo(sql).byTgId(100);
    const conv = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    // No assignment happened — sales-engine fell back gracefully.
    expect(conv.style_id).toBeNull();
    // Legacy persona prompt was used.
    const sys = chatCalls[0]?.messages[0];
    expect(sys?.content).toContain("СТРОГИЕ ПРАВИЛА");
  });

  test("experiment references non-existent style slug → graceful fallback", async () => {
    await sql`DELETE FROM experiments`;
    await sql`
      INSERT INTO experiments (slug, status, allocation_json, success_metric, started_at)
      VALUES ('ghost', 'running', '{"does-not-exist": 100}', 'qualified', 1)
    `;

    await send(port, 100, "hi");
    const user = await new UsersRepo(sql).byTgId(100);
    const conv = (await new ConversationsRepo(sql).byUserId(user!.id))!;
    expect(conv.style_id).toBeNull();
  });
});
