import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import { LeadsService } from "@/leads/service.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";

interface SentCall {
  method: string;
  body: Record<string, unknown>;
}

function fakeTelegram(): {
  client: TelegramClient;
  calls: SentCall[];
} {
  const calls: SentCall[] = [];
  const fetchImpl: FetchLike = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url?: string }).url ?? "";
    const method = url.match(/\/bot[^/]+\/(\w+)/)?.[1] ?? "";
    calls.push({ method, body: {} });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 9999, chat: { id: 0, type: "private" }, date: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as FetchLike;
  return {
    client: new TelegramClient({ token: "t", fetch: fetchImpl }),
    calls,
  };
}

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb({ path: ":memory:" });
});
afterEach(() => db.close());

describe("LeadsService.relayFromOperator", () => {
  function build() {
    const users = new UsersRepo(db);
    const conversations = new ConversationsRepo(db);
    const messages = new MessagesRepo(db);
    const leads = new LeadsRepo(db);
    const u = users.create({ tgUserId: 555_000 });
    const conv = conversations.ensureForUser(u.id);
    const lead = leads.ensureForUser(u.id);
    return { users, conversations, messages, leads, u, conv, lead };
  }

  test("text-only relay sends sendMessage and records role=human", async () => {
    const { users, conversations, messages, leads, u, conv, lead } = build();
    const tg = fakeTelegram();
    const service = new LeadsService({
      leads,
      users,
      conversations,
      messages,
      telegram: tg.client,
      leadsChatId: -100_111,
      visaChatId: null,
    });

    const ok = await service.relayFromOperator({
      lead,
      user: u,
      text: "привет, отправь паспорт пжл",
    });

    expect(ok).toBe(true);
    expect(tg.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    const list = messages.listByConversation(conv.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe("human");
    expect(list[0]!.text).toBe("привет, отправь паспорт пжл");
    const meta = JSON.parse(list[0]!.meta_json ?? "{}") as { source: string };
    expect(meta.source).toBe("operator-relay");
  });

  test("photo relay calls sendPhoto with caption when text present", async () => {
    const { users, conversations, messages, leads, u, lead } = build();
    const tg = fakeTelegram();
    const service = new LeadsService({
      leads,
      users,
      conversations,
      messages,
      telegram: tg.client,
      leadsChatId: -100_111,
      visaChatId: null,
    });
    const ok = await service.relayFromOperator({
      lead,
      user: u,
      text: "образец визы",
      media: { type: "photo", file_id: "AgADpQA" },
    });
    expect(ok).toBe(true);
    expect(tg.calls.map((c) => c.method)).toEqual(["sendPhoto"]);
  });

  test("video / document use respective send methods", async () => {
    const { users, conversations, messages, leads, u, lead } = build();
    const tg = fakeTelegram();
    const service = new LeadsService({
      leads,
      users,
      conversations,
      messages,
      telegram: tg.client,
      leadsChatId: -100_111,
      visaChatId: null,
    });
    await service.relayFromOperator({
      lead,
      user: u,
      media: { type: "video", file_id: "vid" },
    });
    await service.relayFromOperator({
      lead,
      user: u,
      media: { type: "document", file_id: "doc" },
    });
    expect(tg.calls.map((c) => c.method)).toEqual(["sendVideo", "sendDocument"]);
  });

  test("returns false when neither text nor media supplied", async () => {
    const { users, conversations, messages, leads, u, lead } = build();
    const tg = fakeTelegram();
    const service = new LeadsService({
      leads,
      users,
      conversations,
      messages,
      telegram: tg.client,
      leadsChatId: -100_111,
      visaChatId: null,
    });
    const ok = await service.relayFromOperator({ lead, user: u });
    expect(ok).toBe(false);
    expect(tg.calls).toEqual([]);
  });

  test("relay records media metadata for admin chat view", async () => {
    const { users, conversations, messages, leads, u, conv, lead } = build();
    const tg = fakeTelegram();
    const service = new LeadsService({
      leads,
      users,
      conversations,
      messages,
      telegram: tg.client,
      leadsChatId: -100_111,
      visaChatId: null,
    });
    await service.relayFromOperator({
      lead,
      user: u,
      media: { type: "photo", file_id: "AgADxxx" },
    });
    const list = messages.listByConversation(conv.id);
    const meta = JSON.parse(list[0]!.meta_json ?? "{}") as {
      media: { type: string; file_id: string };
    };
    expect(meta.media.type).toBe("photo");
    expect(meta.media.file_id).toBe("AgADxxx");
  });
});
