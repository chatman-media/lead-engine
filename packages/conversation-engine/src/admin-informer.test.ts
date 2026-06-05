import { describe, expect, it } from "bun:test";
import {
  type InformerLevel,
  type InformerSeverity,
  isMuted,
  notificationEventToInformer,
  opsAlertToInformer,
  passesThreshold,
  topicEnabled,
} from "./admin-informer.ts";
import type { OperatorSettings } from "./dal/notifications.ts";
import type { NotificationEvent } from "./notifications.ts";
import type { OpsAlert } from "./ops-alerts.ts";

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
    informerLastDigestAt: null,
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
