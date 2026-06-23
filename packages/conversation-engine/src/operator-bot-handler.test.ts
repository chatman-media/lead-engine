import { describe, expect, it } from "bun:test";
import type { TgUpdate } from "@chatman-media/channel-telegram";
import {
  adminNotifications,
  auditLog,
  channelIdentities,
  channels,
  contacts,
  conversations,
  exchangeOrders,
  funnels,
  leadEvents,
  leads,
  messages,
  operatorActionDrafts,
  outboundQueue,
  stageDefinitions,
} from "@chatman-media/storage";
import type {
  AdminNotificationRow,
  NotificationsRepo,
  OperatorSettings,
} from "./dal/notifications.ts";
import {
  operatorExchangeActionCallbackData,
  parseOperatorActionCallback,
  parseOperatorExchangeActionCallback,
  parseOperatorPreviewCallback,
} from "./operator-bot-actions.ts";
import { OperatorBotHandler, parseMuteSeconds } from "./operator-bot-handler.ts";
import { DraftStore } from "./operator-draft-store.ts";

// ── Fakes ──────────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<OperatorSettings> = {}): OperatorSettings {
  return {
    id: 1,
    adminId: 10,
    tenantId: 1,
    telegramChatId: null,
    linkToken: null,
    linkTokenExpiresAt: null,
    notifyOnAssignedOnly: true,
    informerLevel: "important",
    informerTopics: null,
    informerDigest: "daily",
    informerDigestHour: 9,
    informerTz: "UTC",
    informerMutedUntil: null,
    informerLastDigestAt: null,
    informerQuietFrom: null,
    informerQuietTo: null,
    updatedAt: 0,
    ...overrides,
  };
}

type FakeReplyMarkup = {
  inline_keyboard?: Array<Array<{ text?: string; callback_data?: string; url?: string }>>;
  force_reply?: boolean;
  input_field_placeholder?: string;
};

type FakeRecentNotification = {
  id: number;
  severity: string;
  title: string;
  body: string;
  createdAt: number;
} & Partial<AdminNotificationRow>;

class FakeRepo implements Partial<NotificationsRepo> {
  linked: Array<{ adminId: number; chatId: string }> = [];
  prefs: Array<{ adminId: number } & Record<string, unknown>> = [];
  recent: FakeRecentNotification[] = [];
  groupTokens = new Map<string, { tenantId: number; adminId: number; eventType: string }>();
  createdRules: Array<Record<string, unknown>> = [];
  deletedGroupTokens: string[] = [];
  // #651: форум-правила по chat_id группы + owner-fallback для топик-ответа.
  forumRules = new Map<string, { tenantId: number; ruleId: number }>();
  ownerByTenant = new Map<number, { adminId: number; email: string }>();
  private settings: OperatorSettings[];

  constructor(settings?: OperatorSettings | OperatorSettings[]) {
    this.settings = settings ? (Array.isArray(settings) ? settings : [settings]) : [];
  }

  setSettings(settings?: OperatorSettings | OperatorSettings[]) {
    this.settings = settings ? (Array.isArray(settings) ? settings : [settings]) : [];
  }

  async findByLinkToken(_token: string) {
    return this.settings[0];
  }
  async linkChat(adminId: number, chatId: string) {
    this.linked.push({ adminId, chatId });
  }
  async findOperatorSettings(adminId: number) {
    return this.settings.find((item) => item.adminId === adminId);
  }
  async upsertOperatorSettings(_s: Parameters<NotificationsRepo["upsertOperatorSettings"]>[0]) {}
  async findOperatorSettingsByChatId(chatId: string) {
    return (
      this.settings.find((item) => item.telegramChatId === chatId) ??
      (this.settings.length === 1 && !this.settings[0]?.telegramChatId
        ? this.settings[0]
        : undefined)
    );
  }
  async updateInformerPrefs(adminId: number, p: Record<string, unknown>) {
    this.prefs.push({ adminId, ...p });
  }
  async findGroupLinkToken(token: string) {
    return this.groupTokens.get(token);
  }
  async findForumRuleByTargetId(chatId: string) {
    return this.forumRules.get(chatId);
  }
  async resolveOwnerSettings(tenantId: number) {
    const owner = this.ownerByTenant.get(tenantId);
    if (!owner) return null;
    return { adminId: owner.adminId, email: owner.email, settings: undefined };
  }
  async createRule(
    rule: Omit<Parameters<NotificationsRepo["createRule"]>[0], "id" | "createdAt" | "updatedAt">,
  ) {
    this.createdRules.push(rule as Record<string, unknown>);
    return { id: 1, createdAt: 0, updatedAt: 0, ...rule } as Awaited<
      ReturnType<NotificationsRepo["createRule"]>
    >;
  }
  async deleteGroupLinkToken(token: string) {
    this.deletedGroupTokens.push(token);
  }
  async listRecentNotifications() {
    return this.recent.map(
      (row): AdminNotificationRow => ({
        tenantId: 1,
        adminId: null,
        topic: "system",
        kind: "test",
        dedupKey: `fake-${row.id}`,
        conversationId: null,
        leadId: null,
        targetChatId: null,
        deliveredAt: null,
        digestBatchId: null,
        readAt: null,
        ...row,
      }),
    );
  }
}

class FakeClient {
  sent: Array<{
    chatId: string;
    text: string;
    replyMarkup?: FakeReplyMarkup;
    messageThreadId?: number;
  }> = [];
  edits: Array<{ messageId: number; text: string }> = [];
  answered: Array<{
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
    url?: string;
  }> = [];
  async sendMessage(opts: {
    chatId: string;
    text: string;
    replyMarkup?: FakeReplyMarkup;
    messageThreadId?: number;
  }) {
    this.sent.push(opts);
  }
  async editMessageText(opts: { messageId: number; text: string }) {
    this.edits.push(opts);
  }
  async answerCallbackQuery(opts: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
    url?: string;
  }) {
    this.answered.push(opts);
  }
}

function makeUpdate(text: string, chatId = 1000, isGroup = false): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: {
        id: isGroup ? -chatId : chatId,
        type: isGroup ? "group" : "private",
        title: isGroup ? "Test Group" : undefined,
      },
      from: { id: 5, is_bot: false, first_name: "User" },
      text,
    },
  } as TgUpdate;
}

function makeSendDraftDb(
  opts: {
    contactAttributesJson?: string | null;
    order?: {
      id: number;
      leadId?: number | null;
      status: string;
      verificationId: string | null;
      payoutCode: string | null;
      payoutCodeExpiresAt: number | null;
      payoutMethod?: string | null;
      payoutLocation?: string | null;
      payoutDestinationJson?: string | null;
    };
    lead?: {
      id: number;
      state: string;
      requestType?: string | null;
      stageDefinitionId: number | null;
      stageSlug?: string | null;
      stageFunnelId?: number | null;
      stagePosition?: number | null;
      stageNextStages?: string[];
    };
    riskReviewStage?: {
      id: number;
      slug?: string;
      position: number;
    };
    conversationId?: number;
    contactId?: number;
    draftStatus?: "pending" | "sent" | "cancelled" | "expired" | "failed";
  } = {},
) {
  let contactAttributesJson = opts.contactAttributesJson ?? null;
  let draftStatus = opts.draftStatus ?? "pending";
  const order = opts.order ? { ...opts.order } : null;
  const leadRow = opts.lead ? { ...opts.lead } : null;
  const riskReviewStage = opts.riskReviewStage
    ? { slug: "risk_review", ...opts.riskReviewStage }
    : null;
  const conversationId = opts.conversationId ?? 109;
  const contactId = opts.contactId ?? 55;
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];

  function tableName(table: unknown): string {
    if (table === contacts) return "contacts";
    if (table === conversations) return "conversations";
    if (table === channelIdentities) return "channel_identities";
    if (table === exchangeOrders) return "exchange_orders";
    if (table === leadEvents) return "lead_events";
    if (table === leads) return "leads";
    if (table === operatorActionDrafts) return "operator_action_drafts";
    if (table === messages) return "messages";
    if (table === outboundQueue) return "outbound_queue";
    if (table === auditLog) return "audit_log";
    if (table === adminNotifications) return "admin_notifications";
    if (table === channels) return "channels";
    if (table === stageDefinitions) return "stage_definitions";
    if (table === funnels) return "funnels";
    return "unknown";
  }

  const tx = {
    execute: async () => {},
    select: () => ({
      from: (table: unknown) => {
        if (table === conversations) {
          return {
            where: () => ({
              limit: async () => [{ id: conversationId, contactId }],
            }),
          };
        }
        if (table === channelIdentities) {
          return {
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({
                  limit: async () => [
                    {
                      channelDbId: 3,
                      channelKind: "telegram_bot",
                      externalUserId: "client-telegram-id",
                    },
                  ],
                }),
              }),
            }),
          };
        }
        if (table === contacts) {
          return {
            where: () => ({
              limit: async () => [{ attributesJson: contactAttributesJson }],
            }),
          };
        }
        if (table === exchangeOrders) {
          // Snapshot-семантика как у реального SELECT: дальнейшие UPDATE
          // мутируют `order`, но уже прочитанная строка не меняется.
          const rows = async () => (order ? [{ ...order }] : []);
          return {
            where: () => ({
              limit: rows,
              orderBy: () => ({ limit: rows }),
            }),
          };
        }
        if (table === leads) {
          const rows = async () =>
            leadRow
              ? [
                  {
                    id: leadRow.id,
                    state: leadRow.state,
                    requestType: leadRow.requestType ?? null,
                    stageDefinitionId: leadRow.stageDefinitionId,
                    stageSlug: leadRow.stageSlug ?? leadRow.state,
                    stageFunnelId: leadRow.stageFunnelId ?? null,
                    stagePosition: leadRow.stagePosition ?? null,
                    stageNextStages: leadRow.stageNextStages ?? [],
                  },
                ]
              : [];
          return {
            leftJoin: () => ({
              where: () => ({
                orderBy: () => ({ limit: rows }),
              }),
            }),
          };
        }
        if (table === stageDefinitions) {
          const rows = async () =>
            riskReviewStage
              ? [
                  {
                    id: riskReviewStage.id,
                    slug: riskReviewStage.slug,
                    position: riskReviewStage.position,
                  },
                ]
              : [];
          return {
            innerJoin: () => ({
              where: () => ({
                limit: rows,
              }),
            }),
            where: () => ({
              limit: rows,
            }),
          };
        }
        return {
          where: () => ({
            limit: async () => [],
          }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table: tableName(table), values });
        if (table === contacts && typeof values.attributesJson === "string") {
          contactAttributesJson = values.attributesJson;
        }
        if (table === exchangeOrders && order) {
          Object.assign(order, values);
        }
        if (table === leads && leadRow) {
          Object.assign(leadRow, values);
          if (typeof values.state === "string") {
            leadRow.stageSlug = values.state;
          }
          if (typeof values.stageDefinitionId === "number") {
            leadRow.stageDefinitionId = values.stageDefinitionId;
          }
        }
        return {
          where: () => ({
            returning: async () => {
              if (table === operatorActionDrafts && values.status === "sent") {
                if (draftStatus !== "pending") return [];
                draftStatus = "sent";
                return [{ id: 700 }];
              }
              return [];
            },
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: tableName(table), values });
        if (table === auditLog) audits.push(values);
        return {
          returning: async () => {
            if (table === messages) return [{ id: 501 }];
            if (table === outboundQueue) return [{ id: 601 }];
            return [];
          },
        };
      },
    }),
  };
  const db = {
    transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return {
    audits,
    db,
    inserts,
    order,
    updates,
    draftStatus: () => draftStatus,
    lead: () => (leadRow ? { ...leadRow } : null),
    contactAttributes: () => JSON.parse(contactAttributesJson ?? "{}") as Record<string, unknown>,
  };
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

describe("operator action callbacks", () => {
  it("parses short operator callback payloads", () => {
    expect(parseOperatorActionCallback("op:take:109")).toEqual({
      action: "takeover",
      conversationId: 109,
    });
    expect(parseOperatorActionCallback("op:ai:109")).toEqual({
      action: "return_ai",
      conversationId: 109,
    });
    expect(parseOperatorActionCallback("op:take:not-a-number")).toBeNull();
    expect(parseOperatorActionCallback("lvl:all")).toBeNull();
    expect(parseOperatorPreviewCallback("opm:s:abc123")).toEqual({
      action: "send",
      draftId: "abc123",
    });
    expect(parseOperatorPreviewCallback("opm:c:abc123")).toEqual({
      action: "cancel",
      draftId: "abc123",
    });
    expect(parseOperatorExchangeActionCallback("opx:payok:109")).toEqual({
      action: "payment_confirmed",
      conversationId: 109,
    });
    expect(parseOperatorExchangeActionCallback("opx:payok:109:77")).toEqual({
      action: "payment_confirmed",
      conversationId: 109,
      orderId: 77,
    });
    expect(parseOperatorExchangeActionCallback("opx:kycmore:109")).toEqual({
      action: "kyc_request_materials",
      conversationId: 109,
    });
    expect(parseOperatorExchangeActionCallback("opx:payok:nope")).toBeNull();
    expect(parseOperatorExchangeActionCallback("opx:payok:109:nope")).toBeNull();
  });

  it("callback op:take moves the conversation to human mode", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const writes: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    let mode = "ai";
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ mode }],
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          if (typeof values.mode === "string") mode = values.mode;
          return { where: async () => [] };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          audits.push(values);
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb-op",
        from: { id: 5 },
        data: "op:take:109",
        message: {
          message_id: 9,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(mode).toBe("human");
    expect(writes[0]).toMatchObject({
      mode: "human",
      assignedAdminId: 10,
      unreadCount: 0,
      lastMessageAt: 123,
    });
    expect(audits[0]).toMatchObject({
      tenantId: 3,
      adminId: 10,
      action: "conversation.mode.takeover.operator_bot",
      targetKind: "conversation",
      targetId: "109",
    });
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-op",
      text: "Взято в работу",
    });
    expect(client.sent[0]?.text).toContain("Взято в работу");
    expect(JSON.stringify(client.sent[0]?.replyMarkup)).toContain(
      "https://app.example/conversations/109",
    );

    await handler.handleUpdate({
      update_id: 6,
      callback_query: {
        id: "cb-op-again",
        from: { id: 5 },
        data: "op:take:109",
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(writes).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(client.answered.at(-1)).toMatchObject({
      callbackQueryId: "cb-op-again",
      text: "Уже актуально",
    });
    expect(client.sent.at(-1)?.text).toContain("уже в работе оператора");
  });

  it("tenant-scoped operator callbacks reject mismatched tenant before db writes", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    let transactionCalls = 0;
    const db = {
      transaction: async () => {
        transactionCalls++;
        throw new Error("db should not be touched for wrong tenant callback");
      },
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 6,
      callback_query: {
        id: "cb-wrong-tenant",
        from: { id: 5 },
        data: "op:v1:takeover:99:109",
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(transactionCalls).toBe(0);
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-wrong-tenant",
      text: "Нет доступа к этому чату",
      showAlert: true,
    });
    expect(client.sent).toHaveLength(0);
  });

  it("return_ai callback is idempotent when conversation is already in AI mode", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const writes: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ mode: "ai" }],
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: async () => [] };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          audits.push(values);
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 7,
      callback_query: {
        id: "cb-ai-noop",
        from: { id: 5 },
        data: "op:v1:return_ai:3:109",
        message: {
          message_id: 11,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(writes).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-ai-noop",
      text: "Уже актуально",
    });
    expect(client.sent[0]?.text).toContain("уже под управлением AI");
  });

  it("callback with mismatched tenant payload is rejected before db writes", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const writes: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ mode: "ai" }],
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: async () => [] };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          writes.push(values);
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 6,
      callback_query: {
        id: "cb-wrong-tenant",
        from: { id: 5 },
        data: "op:v1:takeover:999:109",
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(writes).toEqual([]);
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-wrong-tenant",
      text: "Нет доступа к этому чату",
      showAlert: true,
    });
    expect(client.sent).toEqual([]);
  });

  it("repeated takeover callback is a noop without duplicate audit", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const updates: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ mode: "human" }],
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => [] };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          audits.push(values);
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 7,
      callback_query: {
        id: "cb-noop",
        from: { id: 5 },
        data: "op:take:109",
        message: {
          message_id: 11,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-noop",
      text: "Уже актуально",
    });
    expect(client.sent[0]?.text).toContain("уже в работе оператора");
  });

  it("repeated return-AI callback is a noop without duplicate audit", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const updates: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ mode: "ai" }],
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => [] };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          audits.push(values);
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 8,
      callback_query: {
        id: "cb-return-ai-noop",
        from: { id: 5 },
        data: "op:ai:109",
        message: {
          message_id: 12,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-return-ai-noop",
      text: "Уже актуально",
    });
    expect(client.sent[0]?.text).toContain("уже под управлением AI");
  });

  it("reply to an action card sends operator text directly to client (no preview)", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const inserts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const draftRows: Array<Record<string, unknown>> = [];
    let insertIndex = 0;
    const tx = {
      execute: async () => {},
      select: (fields?: Record<string, unknown>) => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (fields && "draftKey" in fields) return draftRows;
              return [{ id: 109, contactId: 55 }];
            },
          }),
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    channelDbId: 3,
                    channelKind: "telegram_bot",
                    externalUserId: "client-telegram-id",
                  },
                ],
              }),
            }),
          }),
        }),
      }),
      insert: () => {
        const current = insertIndex++;
        return {
          values: (values: Record<string, unknown>) => {
            inserts.push({ current, ...values });
            if (typeof values.draftKey === "string") {
              draftRows[0] = {
                id: 700,
                ...values,
                draftKey: values.draftKey,
              };
            }
            return { returning: async () => [{ id: 501 }] };
          },
        };
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          if (typeof values.status === "string" && draftRows[0]) {
            draftRows[0] = { ...draftRows[0], ...values };
          }
          return {
            where: () => ({
              returning: async () => [{ id: draftRows[0]?.id ?? 700 }],
            }),
          };
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 6,
      message: {
        message_id: 20,
        date: 0,
        chat: { id: 777, type: "private" },
        from: { id: 5, is_bot: false, first_name: "Operator" },
        text: "Проверка пройдена, можете оплатить по реквизитам.",
        reply_to_message: {
          message_id: 9,
          date: 0,
          chat: { id: 777, type: "private" },
          text: "Нужно действие оператора",
          reply_markup: {
            inline_keyboard: [[{ text: "Взять", callback_data: "op:take:109" }]],
          },
        },
      },
    } as unknown as TgUpdate);

    // Своё сообщение оператора уходит клиенту НАПРЯМУЮ — без превью/подтверждения.
    expect(client.sent[0]?.text).toContain("Отправлено клиенту");
    expect(client.sent[0]?.replyMarkup).toBeUndefined();
    // В историю записано сообщение оператора (role human).
    expect(
      inserts.some(
        (row) =>
          row.role === "human" && row.text === "Проверка пройдена, можете оплатить по реквизитам.",
      ),
    ).toBe(true);
    // Поставлено в очередь доставки клиенту (idempotencyKey + канал клиента).
    expect(JSON.stringify(inserts)).toContain("operator-bot-reply-");
    expect(JSON.stringify(inserts)).toContain("client-telegram-id");
    // Аудит ответа оператора.
    expect(inserts.some((row) => row.action === "conversation.reply.operator_bot")).toBe(true);
    // Диалог переведён в human mode.
    expect(updates.at(-1)).toMatchObject({
      mode: "human",
      assignedAdminId: 10,
      lastMessageAt: 123,
    });
  });

  it("topic reply (#651): сообщение в треде уходит клиенту по operator_thread_id", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      // Личного chat_id нет — оператор пишет из чата ГРУППЫ, tenant резолвим
      // по форум-правилу (target_id группы), а не по personal chat.
      telegramChatId: null,
    });
    const repo = new FakeRepo(settings);
    // Группа -700 = форум-правило tenant 3; диалог 109 привязан к треду 4242.
    repo.forumRules.set("-700", { tenantId: 3, ruleId: 5 });
    const inserts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    const txQuery = makeSendDraftDb({ conversationId: 109, contactId: 55 });
    // Прямой select репо ConversationsRepo.findConversationByOperatorThread:
    // возвращаем строку диалога с assignedAdminId (назначен пулом).
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 109,
                tenantId: 3,
                userId: 55,
                operatorThreadId: 4242,
                assignedAdminId: 10,
              },
            ],
          }),
        }),
      }),
      transaction: txQuery.db.transaction,
    };
    // Прокидываем наблюдаемые inserts/updates из makeSendDraftDb.
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      appUrl: "https://app.example",
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 50,
      message: {
        message_id: 60,
        date: 0,
        message_thread_id: 4242,
        chat: { id: -700, type: "supergroup", title: "Ops Forum" },
        from: { id: 5, is_bot: false, first_name: "Operator" },
        text: "Реквизиты на оплату придут через минуту.",
      },
    } as unknown as TgUpdate);

    // Подтверждение оператору — в ТОТ ЖЕ топик.
    expect(client.sent[0]?.text).toContain("Отправлено клиенту");
    expect(client.sent[0]?.messageThreadId).toBe(4242);
    // Сообщение оператора записано в историю (role human) и поставлено в очередь.
    expect(
      txQuery.inserts.some(
        (row) =>
          row.table === "messages" &&
          row.values.role === "human" &&
          row.values.text === "Реквизиты на оплату придут через минуту.",
      ),
    ).toBe(true);
    expect(txQuery.inserts.some((row) => row.table === "outbound_queue")).toBe(true);
    // Диалог переведён в human mode на назначенного оператора.
    expect(txQuery.updates.at(-1)).toMatchObject({
      table: "conversations",
      values: expect.objectContaining({ mode: "human", assignedAdminId: 10 }),
    });
    void inserts;
    void updates;
  });

  it("topic reply (#651): нет форум-правила для группы → не обрабатываем как топик", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: null,
    });
    const repo = new FakeRepo(settings);
    // forumRules пуст → группа неизвестна.
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: { select: () => ({}), transaction: async () => {} } as never,
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 51,
      message: {
        message_id: 61,
        date: 0,
        message_thread_id: 4242,
        chat: { id: -701, type: "supergroup", title: "Unknown" },
        from: { id: 5, is_bot: false, first_name: "Operator" },
        text: "ping",
      },
    } as unknown as TgUpdate);

    // Ничего не отправили: не наш форум-чат.
    expect(client.sent).toEqual([]);
  });

  it("«Ответить» открывает окно ответа (force-reply), без канны-заготовки", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 30,
      callback_query: {
        id: "cb-reply",
        from: { id: 5 },
        data: operatorExchangeActionCallbackData("operator_reply", 109),
        message: {
          message_id: 40,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    // Приглашение написать СВОЁ (force-reply), а не канна «Оператор подключился».
    expect(client.sent[0]?.text).toContain("диалог #109");
    expect(client.sent[0]?.text).not.toContain("Оператор подключился");
    expect(client.sent[0]?.replyMarkup?.force_reply).toBe(true);
    expect(client.answered[0]?.text).toContain("Напишите ответ");
  });

  it("durable preview send is scoped to original admin and chat", async () => {
    const repo = new FakeRepo([
      makeSettings({
        adminId: 10,
        tenantId: 3,
        telegramChatId: "777",
      }),
      makeSettings({
        adminId: 20,
        tenantId: 3,
        telegramChatId: "888",
      }),
    ]);
    const writes: Array<Record<string, unknown>> = [];
    const draftRow = {
      id: 700,
      tenantId: 3,
      adminId: 10,
      conversationId: 109,
      draftKey: "abc123",
      chatId: "777",
      status: "pending",
      text: "Не должен уйти клиенту",
      metadataJson: "{}",
      createdAt: 123,
      expiresAt: 723,
    };
    const tx = {
      execute: async () => {},
      select: () => ({
        from: (table: unknown) => {
          if (table === operatorActionDrafts) {
            return {
              where: () => ({
                limit: async () => [draftRow],
              }),
            };
          }
          return {
            where: () => ({
              limit: async () => [],
            }),
          };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: () => ({ returning: async () => [] }) };
        },
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          writes.push(values);
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 9,
      callback_query: {
        id: "cb-cross-admin-send",
        from: { id: 5 },
        data: "opm:s:abc123",
        message: {
          message_id: 23,
          date: 0,
          chat: { id: 888, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(writes).toEqual([]);
    expect(client.answered[0]).toMatchObject({
      callbackQueryId: "cb-cross-admin-send",
      text: "Preview истёк или уже обработан",
      showAlert: true,
    });
    expect(client.sent).toEqual([]);
  });

  it("durable draft double confirm sends only one client message and outbound entry", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const { db, draftStatus, inserts } = makeSendDraftDb();
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });
    const draft = {
      draftId: "abc123",
      dbId: 700,
      tenantId: 3,
      adminId: 10,
      chatId: "777",
      conversationId: 109,
      text: "Отправить один раз.",
      metadata: { source: "telegram_reply_preview" },
      createdAt: 123,
      expiresAt: 723,
    };

    // @ts-expect-error private method
    const first = await handler.sendDraftToClient(draft);
    // @ts-expect-error private method
    const second = await handler.sendDraftToClient(draft);

    expect(first.kind).toBe("sent");
    expect(second.kind).toBe("already_handled");
    expect(draftStatus()).toBe("sent");
    expect(inserts.filter((row) => row.table === "messages")).toHaveLength(1);
    expect(inserts.filter((row) => row.table === "outbound_queue")).toHaveLength(1);
    expect(inserts.filter((row) => row.table === "audit_log")).toHaveLength(1);
  });

  it("exchange quick action creates a send/cancel preview draft", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "cb-exchange",
        from: { id: 5 },
        data: "opx:payok:109:77",
        message: {
          message_id: 22,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(client.answered.at(-1)).toMatchObject({
      callbackQueryId: "cb-exchange",
      text: "Preview готов",
    });
    expect(client.sent.at(-1)?.text).toContain("Оплата подтверждена");
    expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
    expect(client.sent.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text).toBe(
      "Отправить клиенту",
    );
    expect(client.sent.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data).toMatch(
      /^opm:s:/,
    );
  });

  it("exchange quick action with db blocks inaccessible conversations before preview", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const drafts: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          drafts.push(values);
          return { returning: async () => [{ id: 700 }] };
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "cb-exchange-missing-conversation",
        from: { id: 5 },
        data: "opx:payok:999:77",
        message: {
          message_id: 23,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(drafts).toEqual([]);
    expect(client.answered.at(-1)).toMatchObject({
      callbackQueryId: "cb-exchange-missing-conversation",
      text: "Диалог не найден",
      showAlert: true,
    });
    expect(client.sent).toEqual([]);
  });

  it("exchange quick action persists order-scoped draft metadata when db is configured", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const drafts: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: (table: unknown) => {
          if (table === exchangeOrders) {
            return {
              where: () => ({
                limit: async () => [{ id: 77 }],
              }),
            };
          }
          return {
            where: () => ({
              limit: async () => [{ id: 109 }],
            }),
          };
        },
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          drafts.push(values);
          return { returning: async () => [{ id: 700 }] };
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "cb-exchange-db",
        from: { id: 5 },
        data: "opx:payok:109:77",
        message: {
          message_id: 23,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(drafts[0]).toMatchObject({
      tenantId: 3,
      adminId: 10,
      conversationId: 109,
      status: "pending",
      expiresAt: 723,
    });
    expect(JSON.parse(String(drafts[0]?.metadataJson))).toMatchObject({
      source: "operator_bot_exchange_action",
      exchangeAction: "payment_confirmed",
      orderId: 77,
    });
    expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
  });

  it("payout quick action generates order-scoped payout code preview", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const drafts: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: 77,
                status: "paid",
                payoutCode: null,
                payoutCodeExpiresAt: null,
                payoutLocation: "Phuket Old Town",
                payoutMethod: "office_cash",
              },
            ],
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          drafts.push(values);
          return { returning: async () => [{ id: 701 }] };
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "cb-payout",
        from: { id: 5 },
        data: "opx:payout:109:77",
        message: {
          message_id: 24,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(client.answered.at(-1)).toMatchObject({
      callbackQueryId: "cb-payout",
      text: "Preview готов",
    });
    expect(drafts[0]?.text).toContain("Код выдачи");
    expect(String(drafts[0]?.text)).toContain("Phuket Old Town");
    const metadata = JSON.parse(String(drafts[0]?.metadataJson));
    expect(metadata).toMatchObject({
      source: "operator_bot_exchange_action",
      exchangeAction: "payout_ready",
      orderId: 77,
      payoutCodeExpiresAt: 3723,
      payoutCodeGenerated: true,
    });
    expect(String(metadata.payoutCode)).toMatch(/^CODE-77-[A-Z0-9]{6}$/);
    expect(client.sent.at(-1)?.text).toContain("Код выдачи");
    expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
  });

  it("office quick action previews selected office and pickup window", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const drafts: Array<Record<string, unknown>> = [];
    const tx = {
      execute: async () => {},
      select: () => ({
        from: (table: unknown) => {
          if (table === exchangeOrders) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: 77,
                    payoutMethod: "office_cash",
                    payoutLocation: "Bangkok Asok",
                    payoutDestinationJson: JSON.stringify({
                      pickupWindow: "15:00-16:00",
                    }),
                  },
                ],
              }),
            };
          }
          return {
            where: () => ({
              limit: async () => [{ id: 109 }],
            }),
          };
        },
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          drafts.push(values);
          return { returning: async () => [{ id: 702 }] };
        },
      }),
    };
    const db = {
      transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;

    await handler.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "cb-office",
        from: { id: 5 },
        data: "opx:office:109:77",
        message: {
          message_id: 25,
          date: 0,
          chat: { id: 777, type: "private" },
        },
      },
    } as unknown as TgUpdate);

    expect(client.answered.at(-1)).toMatchObject({
      callbackQueryId: "cb-office",
      text: "Preview готов",
    });
    expect(drafts[0]?.text).toContain("Bangkok Asok");
    expect(drafts[0]?.text).toContain("15:00-16:00");
    expect(JSON.parse(String(drafts[0]?.metadataJson))).toMatchObject({
      source: "operator_bot_exchange_action",
      exchangeAction: "office_details",
      orderId: 77,
      payoutMethod: "office_cash",
      payoutLocation: "Bangkok Asok",
      pickupWindow: "15:00-16:00",
    });
    expect(client.sent.at(-1)?.text).toContain("Офис и время");
    expect(client.sent.at(-1)?.text).toContain("Заявка: #77");
  });

  it("confirmed KYC OK preview persists verified contact state", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const { audits, db, inserts, lead, order, contactAttributes, updates } = makeSendDraftDb({
      contactAttributesJson: JSON.stringify({
        city: "Bangkok",
        exchangeKyc: { status: "pending" },
      }),
      order: {
        id: 77,
        leadId: 88,
        status: "quote",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
      },
      lead: {
        id: 88,
        state: "kyc_collection",
        stageDefinitionId: 30,
        stageSlug: "kyc_collection",
        stageFunnelId: 7,
        stagePosition: 3,
        stageNextStages: ["risk_review", "cancelled"],
      },
      riskReviewStage: {
        id: 31,
        position: 4,
      },
    });
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });

    // @ts-expect-error private method
    const result = await handler.sendDraftToClient({
      draftId: "abc123",
      dbId: 700,
      tenantId: 3,
      adminId: 10,
      chatId: "777",
      conversationId: 109,
      text: "✅ Верификация пройдена.",
      metadata: {
        source: "operator_bot_exchange_action",
        exchangeAction: "kyc_approved",
        orderId: 77,
      },
      createdAt: 123,
      expiresAt: 723,
    });

    expect(result.kind).toBe("sent");
    const attrs = contactAttributes();
    expect(attrs.city).toBe("Bangkok");
    expect(attrs.isVerified).toBe(true);
    expect(attrs.exchangeKyc).toMatchObject({
      status: "verified",
      verified: true,
      needsVerification: false,
      reviewedByAdminId: 10,
      reviewedAt: 123,
      source: "operator_bot",
    });
    const kyc = attrs.exchangeKyc as Record<string, unknown>;
    expect(String(kyc.verificationId)).toBe("operator-bot-109-123");
    expect(order?.verificationId).toBe("operator-bot-109-123");
    expect(lead()).toMatchObject({
      id: 88,
      state: "risk_review",
      stageDefinitionId: 31,
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          table: "admin_notifications",
          values: { readAt: 123 },
        },
      ]),
    );

    const leadEvent = inserts.find((row) => row.table === "lead_events")?.values;
    expect(leadEvent).toMatchObject({
      tenantId: 3,
      leadId: 88,
      fromState: "kyc_collection",
      toState: "risk_review",
      byAdminId: 10,
      createdAt: 123,
    });

    const details = JSON.parse(String(audits[0]?.detailsJson)) as Record<string, unknown>;
    expect(details.exchangeSideEffects).toMatchObject({
      action: "kyc_approved",
      contactId: 55,
      status: "verified",
      verified: true,
      orderId: 77,
      orderVerificationPatched: true,
      leadAdvance: {
        leadId: 88,
        advanced: true,
        fromState: "kyc_collection",
        toState: "risk_review",
        stageDefinitionId: 31,
      },
    });
  });

  it("confirmed KYC OK recovers exchange lead from a wrong non-exchange stage", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const { audits, db, lead, order, contactAttributes } = makeSendDraftDb({
      contactAttributesJson: JSON.stringify({
        exchangeKyc: { status: "pending", needsVerification: true },
      }),
      order: {
        id: 77,
        leadId: 88,
        status: "quote",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
      },
      lead: {
        id: 88,
        state: "gc_request",
        requestType: null,
        stageDefinitionId: 44,
        stageSlug: "gc_request",
        stageFunnelId: 12,
        stagePosition: 1,
        stageNextStages: ["gc_operator_review"],
      },
      riskReviewStage: {
        id: 31,
        position: 4,
      },
    });
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });

    // @ts-expect-error private method
    const result = await handler.sendDraftToClient({
      draftId: "abc123",
      dbId: 700,
      tenantId: 3,
      adminId: 10,
      chatId: "777",
      conversationId: 109,
      text: "✅ Верификация пройдена.",
      metadata: {
        source: "operator_bot_exchange_action",
        exchangeAction: "kyc_approved",
        orderId: 77,
      },
      createdAt: 123,
      expiresAt: 723,
    });

    expect(result.kind).toBe("sent");
    expect(contactAttributes().exchangeKyc).toMatchObject({
      status: "verified",
      verified: true,
      needsVerification: false,
    });
    expect(order?.verificationId).toBe("operator-bot-109-123");
    expect(lead()).toMatchObject({
      id: 88,
      state: "risk_review",
      requestType: "exchange",
      stageDefinitionId: 31,
    });

    const details = JSON.parse(String(audits[0]?.detailsJson)) as Record<string, unknown>;
    expect(details.exchangeSideEffects).toMatchObject({
      action: "kyc_approved",
      leadAdvance: {
        leadId: 88,
        advanced: true,
        recovered: true,
        reason: "recovered_wrong_stage",
        fromState: "gc_request",
        toState: "risk_review",
        stageDefinitionId: 31,
      },
    });
  });

  it("confirmed KYC non-approval previews keep contact unverified", async () => {
    for (const [action, expectedStatus] of [
      ["kyc_request_materials", "materials_requested"],
      ["kyc_rejected", "rejected"],
    ] as const) {
      const settings = makeSettings({
        adminId: 10,
        tenantId: 3,
        telegramChatId: "777",
      });
      const repo = new FakeRepo(settings);
      const { db, order, contactAttributes } = makeSendDraftDb({
        contactAttributesJson: JSON.stringify({
          city: "Phuket",
          isVerified: true,
          exchangeKyc: {
            status: "verified",
            verificationId: "old-verification",
          },
        }),
        order: {
          id: 77,
          status: "awaiting_payment",
          verificationId: "old-verification",
          payoutCode: null,
          payoutCodeExpiresAt: null,
        },
      });
      const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
        db: db as never,
        nowEpoch: () => 123,
      });

      // @ts-expect-error private method
      const result = await handler.sendDraftToClient({
        draftId: `${action.replaceAll("_", "")}1`,
        dbId: 700,
        tenantId: 3,
        adminId: 10,
        chatId: "777",
        conversationId: 109,
        text: "KYC decision",
        metadata: {
          source: "operator_bot_exchange_action",
          exchangeAction: action,
          orderId: 77,
        },
        createdAt: 123,
        expiresAt: 723,
      });

      expect(result.kind).toBe("sent");
      const attrs = contactAttributes();
      expect(attrs.city).toBe("Phuket");
      expect(attrs.isVerified).toBe(false);
      expect(attrs.verificationStatus).toBe(expectedStatus);
      expect(attrs.kycStatus).toBe(expectedStatus);
      expect(attrs.exchangeKyc).toMatchObject({
        status: expectedStatus,
        verified: false,
        needsVerification: true,
        verificationId: null,
        reviewedByAdminId: 10,
        source: "operator_bot",
      });
      expect(order?.verificationId).toBeNull();
    }
  });

  it("confirmed office details preview records operator confirmation activity", async () => {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    const { audits, db } = makeSendDraftDb({
      order: {
        id: 77,
        status: "paid",
        verificationId: "operator-bot-109-120",
        payoutCode: null,
        payoutCodeExpiresAt: null,
        payoutMethod: "office_cash",
        payoutLocation: "Bangkok Asok",
        payoutDestinationJson: JSON.stringify({
          pickupWindow: "15:00-16:00",
        }),
      },
    });
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => 123,
    });

    // @ts-expect-error private method
    const result = await handler.sendDraftToClient({
      draftId: "office123",
      dbId: 700,
      tenantId: 3,
      adminId: 10,
      chatId: "777",
      conversationId: 109,
      text: "🏢 Получение в офисе: Bangkok Asok. Окно получения: 15:00-16:00.",
      metadata: {
        source: "operator_bot_exchange_action",
        exchangeAction: "office_details",
        orderId: 77,
        pickupWindow: "15:00-16:00",
      },
      createdAt: 123,
      expiresAt: 723,
    });

    expect(result.kind).toBe("sent");
    const details = JSON.parse(String(audits[0]?.detailsJson)) as Record<string, unknown>;
    expect(details.exchangeSideEffects).toMatchObject({
      action: "office_details",
      orderId: 77,
      confirmationState: "operator_confirmed",
      payoutMethod: "office_cash",
      payoutLocation: "Bangkok Asok",
      pickupWindow: "15:00-16:00",
      statusPatched: false,
    });
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
    const { handler, client } = wire(
      makeSettings({ telegramChatId: "777", informerLevel: "important" }),
    );
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
    expect(client.answered.map((x) => x.callbackQueryId)).toContain("cb1");
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
    expect(repo.prefs[0]?.informerTopics).toBe(
      '{"leads":true,"escalation":true,"orders":false,"system":true}',
    );
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
      makeSettings({
        telegramChatId: "777",
        informerTopics: '{"system":false}',
      }),
    );
    await handler.handleUpdate(makeUpdate("/topics", 777));
    const flat = JSON.stringify(client.sent[0]?.replyMarkup);
    expect(client.sent[0]?.replyMarkup?.inline_keyboard?.length).toBe(4);
    expect(flat).toContain("tpc:system");
    expect(flat).toContain("⬜ 🛠 Система"); // выключена
    expect(flat).toContain("✅ 🆕 Лиды"); // включена
  });

  it("/digest показывает клавиатуру расписания", async () => {
    const { handler, client } = wire(
      makeSettings({ telegramChatId: "777", informerDigest: "daily" }),
    );
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
    expect(repo.prefs[0]).toMatchObject({
      adminId: 10,
      informerDigest: "shift",
    });
  });

  it("/last рендерит ленту последних событий", async () => {
    const { repo, handler, client } = wire(makeSettings({ telegramChatId: "777" }));
    repo.recent = [
      {
        id: 2,
        severity: "critical",
        title: "Канал упал",
        body: "telegram_bot #1",
        createdAt: 1_700_000_000,
      },
      {
        id: 1,
        severity: "info",
        title: "Новый лид",
        body: "",
        createdAt: 1_699_999_000,
      },
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

// Структурный двойник приватного PendingOperatorDraft из operator-bot-handler.ts.
type TestDraft = {
  draftId: string;
  dbId?: number;
  tenantId: number;
  adminId: number;
  chatId: string;
  conversationId: number;
  text: string;
  metadata?: Record<string, unknown>;
  status?: string;
  createdAt: number;
  expiresAt: number;
};

describe("exchange payment/payout side effects", () => {
  function makeHandler(db: unknown, now = 123) {
    const settings = makeSettings({
      adminId: 10,
      tenantId: 3,
      telegramChatId: "777",
    });
    const repo = new FakeRepo(settings);
    return new OperatorBotHandler(repo as unknown as NotificationsRepo, "token", {
      db: db as never,
      nowEpoch: () => now,
    });
  }

  function makeDraft(metadata: Record<string, unknown>): TestDraft {
    return {
      draftId: "abc123",
      dbId: 700,
      tenantId: 3,
      adminId: 10,
      chatId: "777",
      conversationId: 109,
      text: "Статус обновлён.",
      metadata: { source: "operator_bot_exchange_action", ...metadata },
      createdAt: 123,
      expiresAt: 723,
    };
  }

  function auditSideEffects(audits: Array<Record<string, unknown>>): Record<string, unknown> {
    const details = JSON.parse(String(audits[0]?.detailsJson)) as Record<string, unknown>;
    return details.exchangeSideEffects as Record<string, unknown>;
  }

  it("payment_confirmed переводит активную заявку в paid", async () => {
    const { audits, db, order } = makeSendDraftDb({
      order: {
        id: 77,
        status: "awaiting_payment",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
      },
    });
    const handler = makeHandler(db);

    // @ts-expect-error private method
    const result = await handler.sendDraftToClient(
      makeDraft({ exchangeAction: "payment_confirmed", orderId: 77 }),
    );

    expect(result.kind).toBe("sent");
    expect(order?.status).toBe("paid");
    expect(auditSideEffects(audits)).toMatchObject({
      action: "payment_confirmed",
      orderId: 77,
      previousStatus: "awaiting_payment",
      nextStatus: "paid",
      statusPatched: true,
    });
  });

  it("payment_confirmed без заявки фиксирует orderFound=false", async () => {
    const { audits, db } = makeSendDraftDb();
    const handler = makeHandler(db);

    // @ts-expect-error private method
    const result = await handler.sendDraftToClient(
      makeDraft({ exchangeAction: "payment_confirmed", orderId: "88" }),
    );

    expect(result.kind).toBe("sent");
    expect(auditSideEffects(audits)).toMatchObject({
      action: "payment_confirmed",
      orderId: 88,
      orderFound: false,
      statusPatched: false,
    });
  });

  it("payment_confirmed не трогает терминальную заявку", async () => {
    const { audits, db, order } = makeSendDraftDb({
      order: {
        id: 77,
        status: "completed",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
      },
    });
    const handler = makeHandler(db);

    // @ts-expect-error private method
    await handler.sendDraftToClient(
      makeDraft({ exchangeAction: "payment_confirmed", orderId: 77 }),
    );

    expect(order?.status).toBe("completed");
    expect(auditSideEffects(audits)).toMatchObject({
      action: "payment_confirmed",
      orderId: 77,
      previousStatus: "completed",
      statusPatched: false,
    });
  });

  it("payout_ready без заявки фиксирует orderFound=false", async () => {
    const { audits, db } = makeSendDraftDb();
    const handler = makeHandler(db);

    // @ts-expect-error private method
    await handler.sendDraftToClient(makeDraft({ exchangeAction: "payout_ready", orderId: 77 }));

    expect(auditSideEffects(audits)).toMatchObject({
      action: "payout_ready",
      orderId: 77,
      orderFound: false,
      statusPatched: false,
    });
  });

  it("payout_ready из неоплаченного статуса → invalid_status", async () => {
    const { audits, db, order } = makeSendDraftDb({
      order: {
        id: 77,
        status: "quote",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
      },
    });
    const handler = makeHandler(db);

    // @ts-expect-error private method
    await handler.sendDraftToClient(makeDraft({ exchangeAction: "payout_ready", orderId: 77 }));

    expect(order?.status).toBe("quote");
    expect(auditSideEffects(audits)).toMatchObject({
      action: "payout_ready",
      orderId: 77,
      previousStatus: "quote",
      statusPatched: false,
      reason: "invalid_status",
    });
  });

  it("payout_ready из paid генерирует код и переводит в payout", async () => {
    const { audits, db, order } = makeSendDraftDb({
      order: {
        id: 77,
        status: "paid",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: null,
      },
    });
    const handler = makeHandler(db, 1000);

    // @ts-expect-error private method
    await handler.sendDraftToClient(makeDraft({ exchangeAction: "payout_ready", orderId: 77 }));

    expect(order?.status).toBe("payout");
    expect(String(order?.payoutCode)).toMatch(/^CODE-77-[A-Z0-9]{6}$/);
    expect(order?.payoutCodeExpiresAt).toBe(1000 + 60 * 60);
    expect(auditSideEffects(audits)).toMatchObject({
      action: "payout_ready",
      orderId: 77,
      previousStatus: "paid",
      nextStatus: "payout",
      payoutCodeIssued: true,
      statusPatched: true,
    });
  });

  it("payout_ready сохраняет действующий код заявки и не дублирует patch", async () => {
    const { audits, db, order } = makeSendDraftDb({
      order: {
        id: 77,
        status: "payout",
        verificationId: null,
        payoutCode: "CODE-77-AAAAAA",
        payoutCodeExpiresAt: 9999,
      },
    });
    const handler = makeHandler(db, 1000);

    // @ts-expect-error private method
    await handler.sendDraftToClient(makeDraft({ exchangeAction: "payout_ready", orderId: 77 }));

    expect(order?.payoutCode).toBe("CODE-77-AAAAAA");
    expect(order?.payoutCodeExpiresAt).toBe(9999);
    expect(auditSideEffects(audits)).toMatchObject({
      action: "payout_ready",
      previousStatus: "payout",
      statusPatched: false,
    });
  });

  it("payout_ready берёт код и срок из metadata когда заявочный истёк", async () => {
    const { db, order } = makeSendDraftDb({
      order: {
        id: 77,
        status: "paid",
        verificationId: null,
        payoutCode: null,
        payoutCodeExpiresAt: 100,
      },
    });
    const handler = makeHandler(db, 1000);

    // @ts-expect-error private method
    await handler.sendDraftToClient(
      makeDraft({
        exchangeAction: "payout_ready",
        orderId: 77,
        payoutCode: "CODE-77-META11",
        payoutCodeExpiresAt: "5000",
      }),
    );

    expect(order?.status).toBe("payout");
    expect(order?.payoutCode).toBe("CODE-77-META11");
    expect(order?.payoutCodeExpiresAt).toBe(5000);
  });
});

describe("draft cancel/expire persistence", () => {
  function draftWithDb(): TestDraft {
    return {
      draftId: "abc123",
      dbId: 700,
      tenantId: 3,
      adminId: 10,
      chatId: "777",
      conversationId: 109,
      text: "Черновик.",
      metadata: {},
      createdAt: 123,
      expiresAt: 723,
    };
  }

  it("cancelDraft помечает durable-черновик cancelled", async () => {
    const { db, updates } = makeSendDraftDb();
    await new DraftStore(db as never).cancelDraft(draftWithDb(), 200);

    const patch = updates.find((u) => u.table === "operator_action_drafts")?.values;
    expect(patch).toMatchObject({
      status: "cancelled",
      handledAt: 200,
      updatedAt: 200,
    });
  });

  it("expireDraft помечает durable-черновик expired", async () => {
    const { db, updates } = makeSendDraftDb();
    await new DraftStore(db as never).expireDraft(draftWithDb(), 300);

    const patch = updates.find((u) => u.table === "operator_action_drafts")?.values;
    expect(patch).toMatchObject({
      status: "expired",
      handledAt: 300,
      updatedAt: 300,
    });
  });
});

describe("/setup <token> (привязка группы)", () => {
  function wireGroup() {
    const repo = new FakeRepo();
    const handler = new OperatorBotHandler(repo as unknown as NotificationsRepo, "token");
    const client = new FakeClient();
    // @ts-expect-error patch private
    handler.client = client;
    return { repo, handler, client };
  }

  it("в личном чате отказывает", async () => {
    const { repo, handler, client } = wireGroup();
    await handler.handleUpdate(makeUpdate("/setup tok-1", 777, false));
    expect(client.sent[0]?.text).toContain("только в группах");
    expect(repo.createdRules).toEqual([]);
  });

  it("неизвестный токен → ошибка", async () => {
    const { repo, handler, client } = wireGroup();
    await handler.handleUpdate(makeUpdate("/setup tok-unknown", 500, true));
    expect(client.sent[0]?.text).toContain("Токен недействителен");
    expect(repo.createdRules).toEqual([]);
    expect(repo.deletedGroupTokens).toEqual([]);
  });

  it("валидный токен создаёт правило и удаляет токен", async () => {
    const { repo, handler, client } = wireGroup();
    repo.groupTokens.set("tok-ok", {
      tenantId: 7,
      adminId: 10,
      eventType: "operator_handoff_required",
    });

    await handler.handleUpdate(makeUpdate("/setup tok-ok", 500, true));

    expect(repo.createdRules[0]).toMatchObject({
      tenantId: 7,
      eventType: "operator_handoff_required",
      channelType: "telegram_group",
      targetId: "-500",
      priority: "normal",
      isActive: true,
    });
    expect(repo.deletedGroupTokens).toEqual(["tok-ok"]);
    expect(client.sent[0]?.text).toContain("Test Group");
    expect(client.sent[0]?.text).toContain("operator_handoff_required");
  });
});
