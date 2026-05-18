import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { LeadsRepo } from "@/db/repos/leads.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { LeadsService } from "@/leads/service.ts";
import { type FetchLike, TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

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
    const url = typeof input === "string" ? input : ((input as { url?: string }).url ?? "");
    const method = url.match(/\/bot[^/]+\/(\w+)/)?.[1] ?? "";
    calls.push({ method, body: {} });
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: 9999, chat: { id: 0, type: "private" }, date: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as FetchLike;
  return {
    client: new TelegramClient({ token: "t", fetch: fetchImpl }),
    calls,
  };
}

const sql = getTestSql();
beforeAll(() => setupTestDb(sql));
afterEach(() => cleanTestDb(sql));
afterAll(() => sql.end());

describe("LeadsService.relayFromOperator", () => {
  async function build() {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const messages = new MessagesRepo(sql);
    const leads = new LeadsRepo(sql);
    const u = await users.create({ tgUserId: 555_000 });
    const conv = await conversations.ensureForUser(u.id);
    const lead = await leads.ensureForUser(u.id);
    return { users, conversations, messages, leads, u, conv, lead };
  }

  test("text-only relay sends sendMessage and records role=human", async () => {
    const { users, conversations, messages, leads, u, conv, lead } = await build();
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
    const list = await messages.listByConversation(conv.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe("human");
    expect(list[0]!.text).toBe("привет, отправь паспорт пжл");
    const meta = JSON.parse(list[0]!.meta_json ?? "{}") as { source: string };
    expect(meta.source).toBe("operator-relay");
  });

  test("photo relay calls sendPhoto with caption when text present", async () => {
    const { users, conversations, messages, leads, u, lead } = await build();
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
    const { users, conversations, messages, leads, u, lead } = await build();
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
    const { users, conversations, messages, leads, u, lead } = await build();
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
    const { users, conversations, messages, leads, u, conv, lead } = await build();
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
    const list = await messages.listByConversation(conv.id);
    const meta = JSON.parse(list[0]!.meta_json ?? "{}") as {
      media: { type: string; file_id: string };
    };
    expect(meta.media.type).toBe("photo");
    expect(meta.media.file_id).toBe("AgADxxx");
  });

  test("operator-relayed text keeps the em-dash verbatim (no style guard)", async () => {
    const { users, conversations, messages, leads, u, conv, lead } = await build();
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
      text: "Конечно — отправлю образец визы чуть позже",
    });
    const list = await messages.listByConversation(conv.id);
    // Operator is a human; their wording (em-dash, lead-in) goes untouched.
    expect(list[0]!.text).toBe("Конечно — отправлю образец визы чуть позже");
  });
});

describe("LeadsService outgoing style guard", () => {
  async function build() {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const messages = new MessagesRepo(sql);
    const leads = new LeadsRepo(sql);
    const u = await users.create({ tgUserId: 556_000 });
    const conv = await conversations.ensureForUser(u.id);
    const lead = await leads.ensureForUser(u.id);
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
    return { users, conversations, messages, leads, u, conv, lead, service };
  }

  test("template text is style-guarded — em-dash normalised to hyphen", async () => {
    const { messages, u, conv, service } = await build();
    await service.sendIntakeTemplate({ user: u, text: "Заполните анкету — по пунктам." });
    const list = await messages.listByConversation(conv.id);
    expect(list[0]!.text).not.toContain("—");
    expect(list[0]!.text).toBe("Заполните анкету - по пунктам.");
  });

  test("visa interview intro is style-guarded — no em-dash, no robotic lead-in", async () => {
    const { messages, u, conv, lead, service } = await build();
    await service.startVisaInterview({ lead, user: u });
    const list = await messages.listByConversation(conv.id);
    const intro = list[0]!.text;
    expect(intro).not.toContain("—");
    expect(intro.startsWith("Отлично")).toBe(false);
    expect(intro.startsWith("Теперь оформляем рабочую визу")).toBe(true);
    // First interview question is relayed too — also guarded.
    expect(list[1]!.text).not.toContain("—");
  });

  test("default rejection template is guarded; operator custom reason is verbatim", async () => {
    const { messages, conversations, leads, u, conv, service } = await build();
    await service.sendRejection({ user: u });
    let list = await messages.listByConversation(conv.id);
    expect(list[0]!.text).not.toContain("—");

    const u2 = await new UsersRepo(sql).create({ tgUserId: 556_001 });
    const conv2 = await conversations.ensureForUser(u2.id);
    await leads.ensureForUser(u2.id);
    await service.sendRejection({
      user: u2,
      customReason: "Спасибо за интерес — пока не готовы взять.",
    });
    list = await messages.listByConversation(conv2.id);
    expect(list[0]!.text).toBe("Спасибо за интерес — пока не готовы взять.");
  });
});

describe("LeadsService userbot send path", () => {
  test("relayed message links the messages row to the send-queue row", async () => {
    const users = new UsersRepo(sql);
    const conversations = new ConversationsRepo(sql);
    const messages = new MessagesRepo(sql);
    const leads = new LeadsRepo(sql);
    const u = await users.create({ tgUserId: 557_000 });
    const conv = await conversations.ensureForUser(u.id);
    await leads.ensureForUser(u.id);
    const service = new LeadsService({
      leads,
      users,
      conversations,
      messages,
      telegram: fakeTelegram().client,
      leadsChatId: -100_111,
      visaChatId: null,
      userbotEnabled: true,
      sql,
    });

    await service.sendIntakeTemplate({ user: u, text: "Заполните анкету по пунктам." });

    const list = await messages.listByConversation(conv.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.role).toBe("assistant");

    const queue = await sql<
      { message_id: number | null }[]
    >`SELECT message_id FROM userbot_send_queue WHERE tg_user_id = ${u.tg_user_id}`;
    expect(queue).toHaveLength(1);
    // The send-queue row must carry the messages row id so the userbot
    // poller can stamp tg_message_id back after sending — without it,
    // "delete from Telegram" can never work for this message.
    expect(queue[0]!.message_id).toBe(list[0]!.id);
  });
});
