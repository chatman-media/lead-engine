import { afterEach, describe, expect, it } from "bun:test";
import {
  AdminInformer,
  type InformerLevel,
  type InformerSeverity,
  inQuietHours,
  isMuted,
  notificationEventToInformer,
  opsAlertToInformer,
  passesThreshold,
  topicEnabled,
} from "./admin-informer.ts";
import type { OperatorSettings } from "./dal/notifications.ts";
import type { Db } from "./dal/types.ts";
import type { NotificationEvent } from "./notifications.ts";
import type { OpsAlert, OpsTelegramSender } from "./ops-alerts.ts";

function settings(over: Partial<OperatorSettings> = {}): OperatorSettings {
  return {
    id: 1,
    adminId: 10,
    tenantId: 1,
    telegramChatId: "chat",
    linkToken: null,
    linkTokenExpiresAt: null,
    notifyOnAssignedOnly: false,
    informerLevel: "important",
    informerTopics: null,
    informerDigest: "daily",
    informerDigestHour: 9,
    informerTz: "UTC",
    informerMutedUntil: null,
    informerLastDigestAt: null, informerQuietFrom: null, informerQuietTo: null,
    updatedAt: 0,
    ...over,
  };
}

describe("passesThreshold", () => {
  const table: Array<[InformerSeverity, InformerLevel, boolean]> = [
    ["critical", "silent", false],
    ["critical", "critical", true],
    ["important", "critical", false],
    ["important", "important", true],
    ["info", "important", false],
    ["info", "all", true],
    ["critical", "all", true],
  ];
  for (const [sev, level, expected] of table) {
    it(`${sev} @ ${level} → ${expected ? "realtime" : "digest"}`, () => {
      expect(passesThreshold(sev, level)).toBe(expected);
    });
  }
});

describe("topicEnabled", () => {
  it("NULL карта → все темы включены", () => {
    expect(topicEnabled(settings({ informerTopics: null }), "orders")).toBe(true);
  });
  it("ключ false → выключено", () => {
    expect(topicEnabled(settings({ informerTopics: '{"orders":false}' }), "orders")).toBe(false);
  });
  it("отсутствие ключа → включено", () => {
    expect(topicEnabled(settings({ informerTopics: '{"orders":false}' }), "leads")).toBe(true);
  });
  it("битый JSON → fail-safe включено", () => {
    expect(topicEnabled(settings({ informerTopics: "{not json" }), "system")).toBe(true);
  });
});

describe("isMuted", () => {
  it("muted_until в будущем → true", () => {
    expect(isMuted(settings({ informerMutedUntil: 2000 }), 1000)).toBe(true);
  });
  it("muted_until в прошлом → false", () => {
    expect(isMuted(settings({ informerMutedUntil: 500 }), 1000)).toBe(false);
  });
  it("null → false", () => {
    expect(isMuted(settings({ informerMutedUntil: null }), 1000)).toBe(false);
  });
});

describe("inQuietHours", () => {
  const at = (utcHour: number) => 1704067200 + utcHour * 3600; // 2024-01-01T00Z + H

  it("выключено при NULL/равных границах", () => {
    expect(inQuietHours(settings(), at(3))).toBe(false);
    expect(inQuietHours(settings({ informerQuietFrom: 8, informerQuietTo: 8 }), at(8))).toBe(false);
  });
  it("окно через полночь (22→8)", () => {
    const s = settings({ informerQuietFrom: 22, informerQuietTo: 8, informerTz: "UTC" });
    expect(inQuietHours(s, at(23))).toBe(true);
    expect(inQuietHours(s, at(5))).toBe(true);
    expect(inQuietHours(s, at(12))).toBe(false);
  });
  it("окно в пределах суток (9→18)", () => {
    const s = settings({ informerQuietFrom: 9, informerQuietTo: 18, informerTz: "UTC" });
    expect(inQuietHours(s, at(12))).toBe(true);
    expect(inQuietHours(s, at(20))).toBe(false);
    expect(inQuietHours(s, at(8))).toBe(false);
  });
});

describe("opsAlertToInformer", () => {
  const base = (over: Partial<OpsAlert>): OpsAlert => ({
    tenantId: 7,
    kind: "order_stuck",
    severity: "critical",
    title: "t",
    detail: "d",
    dedupKey: "k",
    ...over,
  });
  it("order_stuck critical → orders/critical", () => {
    const e = opsAlertToInformer(base({}));
    expect(e.topic).toBe("orders");
    expect(e.severity).toBe("critical");
  });
  it("rate_feed_stale warning → system/important", () => {
    const e = opsAlertToInformer(base({ kind: "rate_feed_stale", severity: "warning" }));
    expect(e.topic).toBe("system");
    expect(e.severity).toBe("important");
  });
  it("channel_down → system", () => {
    expect(opsAlertToInformer(base({ kind: "channel_down" })).topic).toBe("system");
  });
});

describe("notificationEventToInformer", () => {
  const ev = (over: Partial<NotificationEvent>): NotificationEvent => ({
    tenantId: 3,
    eventType: "human_takeover",
    data: {},
    ...over,
  });
  it("human_takeover → escalation/important", () => {
    const e = notificationEventToInformer(ev({}));
    expect(e?.topic).toBe("escalation");
    expect(e?.severity).toBe("important");
  });
  it("stage_changed → leads/info, dedup по leadId", () => {
    const e = notificationEventToInformer(ev({ eventType: "stage_changed", leadId: 42 }));
    expect(e?.topic).toBe("leads");
    expect(e?.severity).toBe("info");
    expect(e?.dedupKey).toBe("stage_changed:42");
  });
  it("неизвестный тип → null", () => {
    expect(notificationEventToInformer(ev({ eventType: "no_such_event" }))).toBeNull();
  });
  it("url строится из leadId + appUrl", () => {
    const e = notificationEventToInformer(ev({ eventType: "high_value_deal", leadId: 9 }), "http://x");
    expect(e?.url).toBe("http://x/leads/9");
  });
});

// ── AdminInformer error-paths (фейковый Db, без Postgres) ───────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function throwingDb(): Db {
  return {
    transaction: async () => {
      throw new Error("pg down");
    },
  } as unknown as Db;
}

describe("AdminInformer (unit)", () => {
  it("resolveOwnerAdminId: ошибка БД → null (catch-ветка)", async () => {
    const informer = new AdminInformer({
      db: throwingDb(),
      botToken: "",
      appUrl: "http://x",
      telegram: null,
    });
    expect(await informer.resolveOwnerAdminId(1)).toBeNull();
  });

  it("emitOpsAlert: ошибка резолва/записи → warn, без падения", async () => {
    const warns: Array<{ msg: string; ctx: unknown }> = [];
    const informer = new AdminInformer({
      db: throwingDb(),
      botToken: "",
      appUrl: "http://x",
      telegram: null,
      log: { warn: (msg, ctx) => warns.push({ msg, ctx }) },
    });
    await informer.emitOpsAlert({
      tenantId: 5,
      kind: "order_stuck",
      severity: "warning",
      title: "t",
      detail: "d",
      dedupKey: "k",
    });
    expect(warns).toContainEqual(
      expect.objectContaining({
        msg: "[informer] resolve/insert failed",
        ctx: expect.objectContaining({ tenantId: 5 }),
      }),
    );
  });

  it("botToken без telegram-override → отправка через TelegramClient (fetch)", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const informer = new AdminInformer({
      db: throwingDb(),
      botToken: "tok-informer",
      appUrl: "http://x",
    });
    const telegram = (informer as unknown as { telegram: OpsTelegramSender })
      .telegram;
    await telegram.send("100", "<b>hi</b>");
    expect(urls[0]).toContain("/bottok-informer/sendMessage");
  });
});
