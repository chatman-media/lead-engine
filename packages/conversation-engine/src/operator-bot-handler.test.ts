import { describe, expect, it } from "bun:test";
import type { TgUpdate } from "@chatman-media/channel-telegram";
import type { NotificationsRepo, OperatorSettings } from "./dal/notifications.ts";
import { OperatorBotHandler, parseMuteSeconds } from "./operator-bot-handler.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<OperatorSettings> = {}): OperatorSettings {
  return {
    id: 1, adminId: 10, tenantId: 1, telegramChatId: null,
    linkToken: null, linkTokenExpiresAt: null,
    notifyOnAssignedOnly: true,
    informerLevel: "important", informerTopics: null,
    informerDigest: "daily", informerDigestHour: 9, informerTz: "UTC",
    informerMutedUntil: null, informerLastDigestAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

class FakeRepo implements Partial<NotificationsRepo> {
  linked: Array<{ adminId: number; chatId: string }> = [];
  prefs: Array<{ adminId: number } & Record<string, unknown>> = [];
  recent: any[] = [];
  private settings: OperatorSettings | undefined;

  constructor(settings?: OperatorSettings) {
    this.settings = settings;
  }

  async findByLinkToken(_token: string) { return this.settings; }
  async linkChat(adminId: number, chatId: string) { this.linked.push({ adminId, chatId }); }
  async findOperatorSettings(_adminId: number) { return this.settings; }
  async upsertOperatorSettings(_s: any) {}
  async findOperatorSettingsByChatId(_chatId: string) { return this.settings; }
  async updateInformerPrefs(adminId: number, p: Record<string, unknown>) {
    this.prefs.push({ adminId, ...p });
  }
  async listRecentNotifications() { return this.recent; }
}

class FakeClient {
  sent: Array<{ chatId: string; text: string; replyMarkup?: any }> = [];
  edits: Array<{ messageId: number; text: string }> = [];
  answered: string[] = [];
  async sendMessage(opts: { chatId: string; text: string; replyMarkup?: any }) {
    this.sent.push(opts);
  }
  async editMessageText(opts: { messageId: number; text: string }) {
    this.edits.push(opts);
  }
  async answerCallbackQuery(opts: { callbackQueryId: string }) {
    this.answered.push(opts.callbackQueryId);
  }
}

function makeUpdate(text: string, chatId = 1000, isGroup = false): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: isGroup ? -chatId : chatId, type: isGroup ? "group" : "private", title: isGroup ? "Test Group" : undefined },
      from: { id: 5, is_bot: false, first_name: "User" },
      text,
    },
  } as TgUpdate;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("OperatorBotHandler", () => {
  it("does nothing when botToken is empty", async () => {
    const repo = new FakeRepo();
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "");
    await handler.handleUpdate(makeUpdate("/start abc"));
    expect(repo.linked).toEqual([]);
  });

  it("does nothing when update has no message", async () => {
    const repo = new FakeRepo();
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;
    await handler.handleUpdate({ update_id: 1 } as TgUpdate);
    expect(client.sent).toEqual([]);
  });

  describe("/start <token>", () => {
    it("links chatId when token is valid", async () => {
      const settings = makeSettings({ adminId: 10 });
      const repo = new FakeRepo(settings);
      const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
      const client = new FakeClient();
      // @ts-expect-error patch private
      handler.client = client;

      await handler.handleUpdate(makeUpdate("/start valid-token", 777));

      expect(repo.linked).toEqual([{ adminId: 10, chatId: "777" }]);
      expect(client.sent[0]?.text).toContain("✅");
    });

    it("replies with error when token not found", async () => {
      const repo = new FakeRepo(undefined); // token resolves to undefined
      const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
      const client = new FakeClient();
      // @ts-expect-error patch private
      handler.client = client;

      await handler.handleUpdate(makeUpdate("/start bad-token", 777));

      expect(repo.linked).toEqual([]);
      expect(client.sent[0]?.text).toContain("❌");
    });
  });

  describe("/start without token", () => {
    it("replies with greeting", async () => {
      const repo = new FakeRepo();
      const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
      const client = new FakeClient();
      // @ts-expect-error patch private
      handler.client = client;

      await handler.handleUpdate(makeUpdate("/start", 777));

      expect(client.sent[0]?.text).toContain("Привет");
    });
  });

  describe("/setup", () => {
    it("rejects setup in private chat", async () => {
      const repo = new FakeRepo();
      const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
      const client = new FakeClient();
      // @ts-expect-error patch private
      handler.client = client;

      await handler.handleUpdate(makeUpdate("/setup", 777, false));

      expect(client.sent[0]?.text).toContain("/setup работает только в группах");
    });

    it("replies with group ID in group chat", async () => {
      const repo = new FakeRepo();
      const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
      const client = new FakeClient();
      // @ts-expect-error patch private
      handler.client = client;

      await handler.handleUpdate(makeUpdate("/setup", 500, true));

      const reply = client.sent[0];
      expect(reply?.text).toContain("-500");
    });
  });
});

describe("parseMuteSeconds", () => {
  it("единицы m/h/d", () => {
    expect(parseMuteSeconds("30m")).toBe(1800);
    expect(parseMuteSeconds("2h")).toBe(7200);
    expect(parseMuteSeconds("1d")).toBe(86400);
  });
  it("off/0/пусто → 0 (снять мут)", () => {
    expect(parseMuteSeconds("off")).toBe(0);
    expect(parseMuteSeconds("0")).toBe(0);
    expect(parseMuteSeconds("")).toBe(0);
  });
  it("мусор → null", () => {
    expect(parseMuteSeconds("soon")).toBeNull();
    expect(parseMuteSeconds("5x")).toBeNull();
  });
});

describe("informer commands", () => {
  function wire(settings?: OperatorSettings) {
    const repo = new FakeRepo(settings);
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;
    return { repo, handler, client };
  }

  it("/level показывает клавиатуру с текущим уровнем", async () => {
    const { handler, client } = wire(makeSettings({ telegramChatId: "777", informerLevel: "important" }));
    await handler.handleUpdate(makeUpdate("/level", 777));
    const msg = client.sent[0];
    expect(msg?.replyMarkup?.inline_keyboard?.length).toBe(4);
    const flat = JSON.stringify(msg?.replyMarkup);
    expect(flat).toContain("lvl:important");
    expect(flat).toContain("• "); // текущий помечен
  });

  it("/mute 2h пишет informerMutedUntil", async () => {
    const { repo, handler } = wire(makeSettings({ telegramChatId: "777", adminId: 10 }));
    await handler.handleUpdate(makeUpdate("/mute 2h", 777));
    expect(repo.prefs.length).toBe(1);
    expect(repo.prefs[0]?.adminId).toBe(10);
    expect(typeof repo.prefs[0]?.informerMutedUntil).toBe("number");
  });

  it("/mute off снимает мут (null)", async () => {
    const { repo, handler } = wire(makeSettings({ telegramChatId: "777" }));
    await handler.handleUpdate(makeUpdate("/mute off", 777));
    expect(repo.prefs[0]?.informerMutedUntil).toBeNull();
  });

  it("команды без привязки → подсказка", async () => {
    const { handler, client } = wire(undefined);
    await handler.handleUpdate(makeUpdate("/level", 777));
    expect(client.sent[0]?.text).toContain("привяжите");
  });

  it("callback lvl:all обновляет уровень и редактирует клавиатуру", async () => {
    const { repo, handler, client } = wire(makeSettings({ telegramChatId: "777", adminId: 10 }));
    const cb = {
      update_id: 2,
      callback_query: {
        id: "cb1",
        from: { id: 5 },
        data: "lvl:all",
        message: { message_id: 9, date: 0, chat: { id: 777, type: "private" } },
      },
    } as unknown as TgUpdate;
    await handler.handleUpdate(cb);
    expect(repo.prefs[0]).toMatchObject({ adminId: 10, informerLevel: "all" });
    expect(client.edits.length).toBe(1);
    expect(client.answered).toContain("cb1");
  });

  it("callback tpc:orders тоглит тему", async () => {
    const { repo, handler } = wire(makeSettings({ telegramChatId: "777", informerTopics: null }));
    const cb = {
      update_id: 3,
      callback_query: {
        id: "cb2",
        from: { id: 5 },
        data: "tpc:orders",
        message: { message_id: 9, date: 0, chat: { id: 777, type: "private" } },
      },
    } as unknown as TgUpdate;
    await handler.handleUpdate(cb);
    // дефолт all-on → первый тогл выключает orders
    expect(repo.prefs[0]?.informerTopics).toBe('{"leads":true,"escalation":true,"orders":false,"system":true}');
  });

  it("/status показывает уровень, дайджест и темы", async () => {
    const { handler, client } = wire(
      makeSettings({
        telegramChatId: "777",
        informerLevel: "important",
        informerDigest: "daily",
        informerTopics: '{"orders":false}',
      }),
    );
    await handler.handleUpdate(makeUpdate("/status", 777));
    const text = client.sent[0]?.text ?? "";
    expect(text).toContain("Информер");
    expect(text).toContain("Важное");
    expect(text).toContain("⬜ 💱 Заявки"); // выключенная тема
    expect(text).toContain("✅ 🆕 Лиды"); // включённая
  });

  it("/topics показывает тоглы тем с галочками", async () => {
    const { handler, client } = wire(
      makeSettings({ telegramChatId: "777", informerTopics: '{"system":false}' }),
    );
    await handler.handleUpdate(makeUpdate("/topics", 777));
    const flat = JSON.stringify(client.sent[0]?.replyMarkup);
    expect(client.sent[0]?.replyMarkup?.inline_keyboard?.length).toBe(4);
    expect(flat).toContain("tpc:system");
    expect(flat).toContain("⬜ 🛠 Система"); // выключена
    expect(flat).toContain("✅ 🆕 Лиды"); // включена
  });

  it("/digest показывает клавиатуру расписания", async () => {
    const { handler, client } = wire(makeSettings({ telegramChatId: "777", informerDigest: "daily" }));
    await handler.handleUpdate(makeUpdate("/digest", 777));
    const flat = JSON.stringify(client.sent[0]?.replyMarkup);
    expect(flat).toContain("dig:off");
    expect(flat).toContain("dig:daily");
    expect(flat).toContain("dig:shift");
    expect(flat).toContain("• "); // текущий помечен
  });

  it("callback dig:shift обновляет расписание", async () => {
    const { repo, handler } = wire(makeSettings({ telegramChatId: "777", adminId: 10 }));
    const cb = {
      update_id: 4,
      callback_query: {
        id: "cb3",
        from: { id: 5 },
        data: "dig:shift",
        message: { message_id: 9, date: 0, chat: { id: 777, type: "private" } },
      },
    } as unknown as TgUpdate;
    await handler.handleUpdate(cb);
    expect(repo.prefs[0]).toMatchObject({ adminId: 10, informerDigest: "shift" });
  });

  it("/last рендерит ленту последних событий", async () => {
    const { repo, handler, client } = wire(makeSettings({ telegramChatId: "777" }));
    repo.recent = [
      { id: 2, severity: "critical", title: "Канал упал", body: "telegram_bot #1", createdAt: 1_700_000_000 },
      { id: 1, severity: "info", title: "Новый лид", body: "", createdAt: 1_699_999_000 },
    ];
    await handler.handleUpdate(makeUpdate("/last", 777));
    const text = client.sent[0]?.text ?? "";
    expect(text).toContain("Последние 2");
    expect(text).toContain("Канал упал");
    expect(text).toContain("🔴");
  });

  it("/last на пустой ленте → подсказка", async () => {
    const { repo, handler, client } = wire(makeSettings({ telegramChatId: "777" }));
    repo.recent = [];
    await handler.handleUpdate(makeUpdate("/last", 777));
    expect(client.sent[0]?.text).toContain("пусто");
  });
});
