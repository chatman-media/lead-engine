import { describe, expect, it } from "bun:test";
import type { TgUpdate } from "@chatman-media/channel-telegram";
import type { NotificationsRepo, OperatorSettings } from "./dal/notifications.ts";
import { OperatorBotHandler } from "./operator-bot-handler.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<OperatorSettings> = {}): OperatorSettings {
  return {
    id: 1, adminId: 10, tenantId: 1, telegramChatId: null,
    linkToken: null, linkTokenExpiresAt: null,
    notifyOnAssignedOnly: true, updatedAt: 0,
    ...overrides,
  };
}

class FakeRepo implements Partial<NotificationsRepo> {
  linked: Array<{ adminId: number; chatId: string }> = [];
  private settings: OperatorSettings | undefined;

  constructor(settings?: OperatorSettings) {
    this.settings = settings;
  }

  async findByLinkToken(_token: string) { return this.settings; }
  async linkChat(adminId: number, chatId: string) { this.linked.push({ adminId, chatId }); }
  async findOperatorSettings(_adminId: number) { return this.settings; }
  async upsertOperatorSettings(_s: any) {}
}

class FakeClient {
  sent: Array<{ chat_id: string; text: string }> = [];
  async sendMessage(opts: { chat_id: string; text: string }) {
    this.sent.push(opts);
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
