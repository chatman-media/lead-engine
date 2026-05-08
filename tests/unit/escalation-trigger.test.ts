import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import type { ChatClient } from "@/rag/chat.ts";
import type { EmbeddingClient } from "@/rag/embed.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { containsEscalationTrigger } from "@/telegram/escalation.ts";
import type { TgUpdate } from "@/telegram/types.ts";
import { createWebhookHandler } from "@/telegram/webhook.ts";

describe("containsEscalationTrigger", () => {
  test("matches Russian and English variants regardless of case/punctuation", () => {
    for (const text of [
      "позови оператора",
      "Хочу к Оператору!",
      "talk to a human please",
      "operator please",
      "/operator",
      "/human",
      "OPERATOR",
    ]) {
      expect(containsEscalationTrigger(text)).toBe(true);
    }
  });

  test("does not falsely match unrelated words", () => {
    for (const text of [
      "оперативно отвечайте",
      "humanitarian aid",
      "operating system",
      "hi there",
      "",
    ]) {
      expect(containsEscalationTrigger(text)).toBe(false);
    }
  });
});

const SECRET = "s";

function fakeChat(reply: string): ChatClient {
  return {
    async complete() {
      return reply;
    },
  };
}

function fakeEmbedder(): EmbeddingClient {
  return {
    dim: 1536,
    async embed(inputs) {
      return inputs.map(() => new Array<number>(1536).fill(0));
    },
  };
}

interface OutgoingCall {
  method: string;
  body: Record<string, unknown>;
}

let db: ReturnType<typeof openDb>;
let sent: OutgoingCall[];
let handler: ReturnType<typeof createWebhookHandler>;
let chatCalls: number;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
  sent = [];
  chatCalls = 0;
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
            ? {
                message_id: 1,
                chat: { id: body.chat_id, type: "private" },
                date: 0,
                text: body.text,
              }
            : true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const trackingChat: ChatClient = {
    async complete(...args) {
      chatCalls++;
      return fakeChat("rag answer").complete(...args);
    },
  };
  handler = createWebhookHandler({
    db,
    telegram,
    webhookSecret: SECRET,
    rag: { embedder: fakeEmbedder(), chat: trackingChat },
    // Tests assert post-conditions inline; production fires-and-forgets.
    awaitProcessing: true,
  });
});
afterEach(() => db.close());

function update(fromId: number, text: string): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: fromId, is_bot: false, first_name: "U" },
      chat: { id: fromId, type: "private" },
      date: 0,
      text,
    },
  };
}

async function call(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = { secret: url.pathname.split("/").pop()! };
  return handler({ req, params });
}

describe("webhook escalation trigger", () => {
  test("trigger word in user message switches mode to queued and skips RAG", async () => {
    const users = new UsersRepo(db);
    const u = users.create({ tgUserId: 42 });

    const res = await call(
      new Request(`http://x/telegram/${SECRET}`, {
        method: "POST",
        body: JSON.stringify(update(42, "Хочу позвать оператора")),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);

    expect(chatCalls).toBe(0);
    expect(sent).toHaveLength(0);

    const conv = new ConversationsRepo(db).byUserId(u.id)!;
    expect(conv.mode).toBe("queued");

    const msgs = new MessagesRepo(db).listByConversation(conv.id);
    expect(msgs.map((m) => m.role)).toEqual(["user"]);
  });

  test("non-trigger message in ai mode still goes through RAG", async () => {
    const users = new UsersRepo(db);
    users.create({ tgUserId: 43 });

    await call(
      new Request(`http://x/telegram/${SECRET}`, {
        method: "POST",
        body: JSON.stringify(update(43, "обычный вопрос")),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(chatCalls).toBe(0); // KB is empty -> NO_CONTEXT without calling chat
    const conv = new ConversationsRepo(db).byUserId(new UsersRepo(db).byTgId(43)!.id)!;
    // NO_CONTEXT now queues conversation for operator reply
    expect(conv.mode).toBe("queued");
  });
});
