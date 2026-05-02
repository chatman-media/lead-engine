/**
 * End-to-end integration test for the AI ↔ human handoff lifecycle.
 *
 * Unlike the per-route tests, this one boots the real `createServer`
 * (Bun.serve + WebSocket) and exercises the full chain:
 *   webhook → repos → bus → admin REST → ws clients → admin reply → release.
 *
 * It catches regressions that slip through unit tests, e.g.:
 *  - the bus not being wired into the webhook handler,
 *  - escalation flow leaking forbidden words ("оператор", "бот", "ассистент")
 *    into the user-visible reply when persona.role = "human",
 *  - human mode accidentally still calling sendMessage,
 *  - release() failing to flip mode back to "ai" so the next user message
 *    is silently dropped.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient, ChatMessage } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { createServer } from "@/server.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";
import type { TgUpdate } from "@/telegram/types.ts";
import {
  ESCALATION_REPLIES,
  pickHumanStallPhrase,
} from "@/telegram/webhook.ts";

const SECRET = "lifecycle-secret";
const DIM = 8;
const TG_USER_ID = 4242;

function unitVec(seed: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[seed % DIM] = 1;
  return v;
}

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: DIM,
    async embed(inputs) {
      return inputs.map((t) => unitVec(t.length));
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
  let nextTgMsgId = 1000;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const apiMethod = url.split("/").pop() ?? "";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    sent.push({ method: apiMethod, body });
    const result =
      apiMethod === "sendMessage"
        ? {
            message_id: nextTgMsgId++,
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
  const telegram = new TelegramClient({
    token: "test-token",
    fetch: fetchImpl,
  });
  const server = createServer({
    db,
    telegram,
    webhookSecret: SECRET,
    rag: {
      embedder: fakeEmbedder(),
      chat: fakeChat("AI говорит привет"),
      persona: { name: "Алина", role: "human", company: "ACME" },
    },
    port: 0,
    serveUi: false,
    // Integration test asserts post-conditions inline (DB rows, WS frames);
    // production fires-and-forgets to keep the Telegram ack under 60s.
    awaitWebhookProcessing: true,
  });
  return { db, server, sent };
}

function teardown(ctx: ReturnType<typeof setup>) {
  ctx.server.stop(true);
  ctx.db.close();
}

let ctx: ReturnType<typeof setup>;

beforeEach(() => {
  ctx = setup();
});

afterEach(() => {
  teardown(ctx);
});

function origin(): string {
  return `http://127.0.0.1:${ctx.server.port}`;
}

function update(text: string, overrides: Partial<TgUpdate["message"]> = {}): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      from: { id: TG_USER_ID, is_bot: false, first_name: "Tester" },
      chat: { id: TG_USER_ID, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
      ...overrides,
    },
  };
}

async function postWebhook(text: string): Promise<Response> {
  return fetch(`${origin()}/telegram/${SECRET}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update(text)),
  });
}

async function loginAsAdmin(): Promise<string> {
  const admins = new AdminsRepo(ctx.db);
  await admins.create({ email: "ops@x.test", password: "longenough" });
  const res = await fetch(`${origin()}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ops@x.test", password: "longenough" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie issued");
  return setCookie.split(";")[0]!;
}

interface WsHandle {
  ws: WebSocket;
  events: Array<Record<string, unknown>>;
}

function connectAdminWs(cookie: string): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.server.port}/admin/api/ws`, {
      headers: { cookie },
    } as unknown as string);
    const events: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (e) => {
      try {
        events.push(JSON.parse(e.data as string));
      } catch {
        /* ignore non-JSON frames */
      }
    });
    ws.addEventListener("open", () => resolve({ ws, events }));
    ws.addEventListener("error", () => {});
    setTimeout(() => reject(new Error("ws open timeout")), 2000);
  });
}

async function waitFor<T>(
  cond: () => T | undefined,
  timeoutMs = 1500,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("AI ↔ human handoff lifecycle (integration)", () => {
  test("ai → escalation → human takeover → admin reply → release → ai", async () => {
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const messages = new MessagesRepo(ctx.db);

    const u = users.create({ tgUserId: TG_USER_ID, tgUsername: "tester" });

    // Empty KB → answerWithRag returns NO_CONTEXT_MARKER even though the
    // chat fake says "AI говорит привет". That's intentional: the very
    // first message is off-topic (no KB hits) and must escalate.
    // We verify that path separately below — first add a KB hit so the
    // initial message goes through the AI path.
    const kb = new (await import("@/db/repos/kb.ts")).KbRepo(ctx.db);
    const doc = kb.upsertDocument({
      source: "mem://t",
      title: "doc",
      contentHash: "h",
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "Some company info.",
      tokenCount: 4,
      embedding: unitVec(7),
    });

    // --- Step 1: AI answers normally ---
    {
      const res = await postWebhook("привет");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe("ai");
    }
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]!.method).toBe("sendMessage");
    expect(ctx.sent[0]!.body.text).toBe("AI говорит привет");

    const conv = conversations.byUserId(u.id)!;
    expect(conv.mode).toBe("ai");

    const escalateUserText = "позови оператора пожалуйста";
    const escalationExpected = pickHumanStallPhrase(
      ESCALATION_REPLIES,
      conv.id,
      escalateUserText,
    );

    // --- Step 2: User explicitly asks for a human → escalate ---
    {
      const res = await postWebhook(escalateUserText);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string; reason?: string };
      expect(body.mode).toBe("queued");
      expect(body.reason).toBe("user-trigger");
    }
    expect(ctx.sent).toHaveLength(2);
    const escalationOut = String(ctx.sent[1]!.body.text);
    expect(escalationOut).toBe(escalationExpected);
    // Critical: the "human" persona reply must NOT leak words that would
    // out the bot to a candidate.
    expect(escalationOut).not.toMatch(/оператор|operator|бот\b|ассистент|нейросет/i);
    expect(conversations.byId(conv.id)!.mode).toBe("queued");
    expect(conversations.byId(conv.id)!.escalated_at).not.toBeNull();

    // --- Step 3: Admin logs in, opens a WS, sees the queued conversation ---
    const cookie = await loginAsAdmin();
    const wsHandle = await connectAdminWs(cookie);

    const listRes = await fetch(
      `${origin()}/admin/api/conversations?escalated=1`,
      { headers: { cookie } },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      conversations: Array<{ id: number; mode: string; user: { tg_user_id: number } }>;
    };
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]!.id).toBe(conv.id);
    expect(list.conversations[0]!.mode).toBe("queued");
    expect(list.conversations[0]!.user.tg_user_id).toBe(TG_USER_ID);

    // --- Step 4: Admin takes the conversation → mode=human + WS event ---
    const sendCountBeforeTake = ctx.sent.length;
    const takeRes = await fetch(
      `${origin()}/admin/api/conversations/${conv.id}/take`,
      { method: "POST", headers: { cookie } },
    );
    expect(takeRes.status).toBe(200);
    expect(conversations.byId(conv.id)!.mode).toBe("human");
    expect(conversations.byId(conv.id)!.assigned_admin_id).not.toBeNull();
    // No outbound Telegram traffic on take.
    expect(ctx.sent).toHaveLength(sendCountBeforeTake);

    const takenEvt = await waitFor(() =>
      wsHandle.events.find(
        (e) =>
          (e as { type?: string }).type === "conversation:updated" &&
          (e as { conversationId?: number }).conversationId === conv.id,
      ),
    );
    expect(takenEvt).toBeDefined();

    // --- Step 5: User keeps writing while in human mode — server stores
    //              the message but MUST NOT auto-reply ---
    const eventsBeforeUserMsg = wsHandle.events.length;
    const sendCountBeforeUserMsg = ctx.sent.length;
    {
      const res = await postWebhook("я тут, жду ответа");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe("human");
    }
    expect(ctx.sent).toHaveLength(sendCountBeforeUserMsg); // no auto-reply

    // But the WS still fires message:new for live admin UIs.
    const inboundEvt = (await waitFor(() =>
      wsHandle.events
        .slice(eventsBeforeUserMsg)
        .find(
          (e) =>
            (e as { type?: string }).type === "message:new" &&
            (e as { tgUserId?: number }).tgUserId === TG_USER_ID,
        ),
    )) as { conversationId: number };
    expect(inboundEvt.conversationId).toBe(conv.id);

    // --- Step 6: Admin replies → Telegram receives it, persisted as role=human,
    //              WS broadcasts message:new ---
    const eventsBeforeReply = wsHandle.events.length;
    const replyRes = await fetch(
      `${origin()}/admin/api/conversations/${conv.id}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ text: "Привет, я Алина. Сейчас помогу!" }),
      },
    );
    expect(replyRes.status).toBe(200);

    const lastSend = ctx.sent.at(-1)!;
    expect(lastSend.method).toBe("sendMessage");
    expect(lastSend.body.chat_id).toBe(TG_USER_ID);
    expect(lastSend.body.text).toBe("Привет, я Алина. Сейчас помогу!");

    const allMessages = messages.listByConversation(conv.id);
    const lastPersisted = allMessages.at(-1)!;
    expect(lastPersisted.role).toBe("human");
    expect(lastPersisted.text).toBe("Привет, я Алина. Сейчас помогу!");
    expect(lastPersisted.tg_message_id).not.toBeNull();

    const adminMsgEvt = await waitFor(() =>
      wsHandle.events
        .slice(eventsBeforeReply)
        .find(
          (e) =>
            (e as { type?: string }).type === "message:new" &&
            (e as { tgUserId?: number }).tgUserId === TG_USER_ID,
        ),
    );
    expect(adminMsgEvt).toBeDefined();

    // Conversation should still be in human mode after the reply.
    expect(conversations.byId(conv.id)!.mode).toBe("human");

    // --- Step 7: Admin releases → mode flips back to ai, assignment cleared ---
    const releaseRes = await fetch(
      `${origin()}/admin/api/conversations/${conv.id}/release`,
      { method: "POST", headers: { cookie } },
    );
    expect(releaseRes.status).toBe(200);
    const released = conversations.byId(conv.id)!;
    expect(released.mode).toBe("ai");
    expect(released.assigned_admin_id).toBeNull();
    expect(released.escalated_at).toBeNull();

    // --- Step 8: Next user message goes back through the AI path ---
    const sendCountBeforeFinal = ctx.sent.length;
    {
      const res = await postWebhook("ещё вопрос");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string };
      expect(body.mode).toBe("ai");
    }
    expect(ctx.sent).toHaveLength(sendCountBeforeFinal + 1);
    expect(ctx.sent.at(-1)!.body.text).toBe("AI говорит привет");

    // --- Final transcript sanity check ---
    const finalMsgs = messages.listByConversation(conv.id).map((m) => ({
      role: m.role,
      text: m.text,
    }));
    expect(finalMsgs).toEqual([
      { role: "user", text: "привет" },
      { role: "assistant", text: "AI говорит привет" },
      { role: "user", text: escalateUserText },
      { role: "assistant", text: escalationExpected },
      { role: "user", text: "я тут, жду ответа" },
      { role: "human", text: "Привет, я Алина. Сейчас помогу!" },
      { role: "user", text: "ещё вопрос" },
      { role: "assistant", text: "AI говорит привет" },
    ]);

    wsHandle.ws.close();
  });

  test("admin reply is rejected with 409 while conversation is still in ai mode", async () => {
    // Guards against an admin UI bug where the operator could reply to a chat
    // that hasn't been taken yet — would cause inconsistent state and an
    // unsolicited "human" message to the user.
    const users = new UsersRepo(ctx.db);
    const conversations = new ConversationsRepo(ctx.db);
    const u = users.create({ tgUserId: TG_USER_ID });
    const c = conversations.ensureForUser(u.id);
    expect(c.mode).toBe("ai");

    const cookie = await loginAsAdmin();
    const res = await fetch(
      `${origin()}/admin/api/conversations/${c.id}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ text: "should not be sent" }),
      },
    );
    expect(res.status).toBe(409);
    expect(ctx.sent).toHaveLength(0);
    const msgs = new MessagesRepo(ctx.db).listByConversation(c.id);
    expect(msgs).toHaveLength(0);
  });
});
