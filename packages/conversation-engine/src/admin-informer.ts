/**
 * AdminInformer — единый «информер» владельца тенанта. В него сливаются оба
 * существующих продюсера событий (OpsAlertRouter и NotificationService), а
 * решение о доставке принимается по настройкам владельца:
 *
 *   - подписки по темам (informer_topics): тема выключена → событие отброшено;
 *   - порог важности (informer_level): silent | critical | important | all;
 *   - мут (informer_muted_until): гасит реалтайм, но событие копится в дайджест.
 *
 * Доставка:
 *   - событие проходит порог и не в муте → реалтайм-пуш в личный Telegram
 *     владельца (тот же operator-бот) + email-гарантия для critical;
 *   - иначе → строка остаётся в ленте admin_notifications с delivered_at=NULL,
 *     откуда её заберёт informer-digest-sweep (apps/worker).
 *
 * Лента (admin_notifications) пишется на КАЖДОЕ принятое событие — это и
 * источник дайджеста, и scrollback для бот-команды «/last», и persisted-дедуп
 * (переживает рестарт процесса, в отличие от in-memory cooldown).
 *
 * Адресат — superadmin тенанта (владелец). Операторы продолжают получать свои
 * уведомления через NotificationService (правила/группы) — informer их не
 * трогает; per-operator-рассылка владельцу отключается на стороне notify(),
 * чтобы не было дублей.
 *
 * Зависимости (TelegramClient, email) инжектятся — пакет без app-зависимостей.
 */

import { TelegramClient } from "@chatman-media/channel-telegram";
import { NotificationsRepo, type OperatorSettings } from "./dal/notifications.ts";
import type { Db } from "./dal/types.ts";
import type { NotificationEvent } from "./notifications.ts";
import type { OpsAlert, OpsAlertKind, OpsEmailSender, OpsSeverity, OpsTelegramSender } from "./ops-alerts.ts";
import { withTenant } from "./with-tenant.ts";

export type InformerTopic = "leads" | "escalation" | "orders" | "system";
export type InformerSeverity = "critical" | "important" | "info";
export type InformerLevel = "silent" | "critical" | "important" | "all";

export const INFORMER_TOPICS: readonly InformerTopic[] = ["leads", "escalation", "orders", "system"];

export interface InformerEvent {
  tenantId: number;
  topic: InformerTopic;
  severity: InformerSeverity;
  /** Исходный тип события (order_stuck, stage_changed, ...). */
  kind: string;
  title: string;
  detail: string;
  /** Уникален для конкретного условия — основа persisted-дедупа. */
  dedupKey: string;
  /** Глубокая ссылка (например <appUrl>/leads/123) — добавляется ссылкой в сообщение. */
  url?: string;
}

// ── Шкалы порога ─────────────────────────────────────────────────────────

const SEV_RANK: Record<InformerSeverity, number> = { info: 1, important: 2, critical: 3 };
/** Минимальный ранг важности, который проходит в реалтайм при данном уровне. */
const LEVEL_THRESHOLD: Record<InformerLevel, number> = {
  silent: 4, // ничего (4 > critical=3)
  critical: 3,
  important: 2,
  all: 1,
};

export function passesThreshold(severity: InformerSeverity, level: InformerLevel): boolean {
  return SEV_RANK[severity] >= LEVEL_THRESHOLD[level];
}

export function isMuted(settings: OperatorSettings | undefined, nowEpoch: number): boolean {
  const until = settings?.informerMutedUntil;
  return typeof until === "number" && until > nowEpoch;
}

/** Тема включена, если карты нет (NULL = все включены) или ключ != false. */
export function topicEnabled(settings: OperatorSettings | undefined, topic: InformerTopic): boolean {
  const raw = settings?.informerTopics;
  if (!raw) return true;
  try {
    const map = JSON.parse(raw) as Record<string, boolean>;
    return map[topic] !== false;
  } catch {
    return true;
  }
}

// ── Мапперы существующих событий → InformerEvent ──────────────────────────

const OPS_TOPIC: Record<OpsAlertKind, InformerTopic> = {
  rate_anomaly: "system",
  rate_feed_stale: "system",
  channel_down: "system",
  order_stuck: "orders",
  volume_spike: "orders",
};

function mapOpsSeverity(s: OpsSeverity): InformerSeverity {
  return s === "warning" ? "important" : s; // critical|info — без изменений
}

export function opsAlertToInformer(alert: OpsAlert): InformerEvent {
  return {
    tenantId: alert.tenantId,
    topic: OPS_TOPIC[alert.kind] ?? "system",
    severity: mapOpsSeverity(alert.severity),
    kind: alert.kind,
    title: alert.title,
    detail: alert.detail,
    dedupKey: alert.dedupKey,
  };
}

interface NotifMeta {
  topic: InformerTopic;
  severity: InformerSeverity;
  title: string;
}

const NOTIF_MAP: Record<string, NotifMeta> = {
  lead_intake_complete: { topic: "leads", severity: "info", title: "Новый лид" },
  stage_changed: { topic: "leads", severity: "info", title: "Смена стадии" },
  lead_stale: { topic: "leads", severity: "info", title: "Лид завис" },
  human_takeover: { topic: "escalation", severity: "important", title: "Нужна помощь оператора" },
  verification_requested: { topic: "escalation", severity: "important", title: "Видео-верификация" },
  document_uploaded: { topic: "escalation", severity: "info", title: "Загружен документ" },
  high_value_deal: { topic: "orders", severity: "important", title: "Крупная сделка" },
};

/** null — если тип события не предназначен для владельца-информера. */
export function notificationEventToInformer(
  event: NotificationEvent,
  appUrl?: string,
): InformerEvent | null {
  const meta = NOTIF_MAP[event.eventType];
  if (!meta) return null;

  const parts: string[] = [];
  const who = event.data.displayName;
  if (typeof who === "string" && who) parts.push(`Клиент: ${who}`);
  if (event.data.fromStage && event.data.toStage) {
    parts.push(`${event.data.fromStage} → ${event.data.toStage}`);
  } else if (event.data.toStage) {
    parts.push(`Стадия: ${event.data.toStage}`);
  }
  if (event.data.amount !== undefined && event.data.amount !== null) {
    parts.push(`Сумма: ${event.data.amount}`);
  }

  const ref = event.leadId ?? event.conversationId ?? event.contactId ?? 0;
  const url =
    event.leadId && appUrl
      ? `${appUrl}/leads/${event.leadId}`
      : event.conversationId && appUrl
        ? `${appUrl}/conversations/${event.conversationId}`
        : undefined;

  return {
    tenantId: event.tenantId,
    topic: meta.topic,
    severity: meta.severity,
    kind: event.eventType,
    title: meta.title,
    detail: parts.join(" · "),
    dedupKey: `${event.eventType}:${ref}`,
    url,
  };
}

// ── Сервис ────────────────────────────────────────────────────────────────

const SEV_EMOJI: Record<InformerSeverity, string> = {
  critical: "🔴",
  important: "🟡",
  info: "ℹ️",
};
const TOPIC_EMOJI: Record<InformerTopic, string> = {
  leads: "🆕",
  escalation: "🆘",
  orders: "💱",
  system: "🛠",
};

function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface AdminInformerDeps {
  db: Db;
  /** Токен operator-бота (PLATFORM_OPERATOR_BOT_TOKEN). Пусто → Telegram отключён. */
  botToken: string;
  appUrl: string;
  /** Отправитель email (для critical-гарантии). null → email-канал отключён. */
  email?: OpsEmailSender | null;
  /** Override отправителя Telegram (для тестов). По умолчанию строится из botToken. */
  telegram?: OpsTelegramSender | null;
  /** Анти-шторм: не повторять (tenant, dedupKey) чаще, сек. Default 1800 (30 мин). */
  cooldownSec?: number;
  log?: { warn?: (msg: string, ctx?: unknown) => void; info?: (msg: string, ctx?: unknown) => void };
}

interface DeliveryPlan {
  rowId: number;
  chatId: string | null;
  email: string | null;
  realtime: boolean;
}

export class AdminInformer {
  private readonly telegram: OpsTelegramSender | null;
  private readonly cooldownSec: number;
  /** Не-tenant-bound репо для пост-транзакционных апдейтов ленты (таблица без RLS). */
  private readonly repo: NotificationsRepo;

  constructor(private readonly deps: AdminInformerDeps) {
    if (deps.telegram !== undefined) {
      this.telegram = deps.telegram;
    } else if (deps.botToken) {
      const client = new TelegramClient({ token: deps.botToken });
      this.telegram = {
        send: (chatId, htmlText) =>
          client
            .sendMessage({ chatId, text: htmlText, parseMode: "HTML", disableWebPagePreview: true })
            .then(() => undefined),
      };
    } else {
      this.telegram = null;
    }
    this.cooldownSec = deps.cooldownSec ?? 30 * 60;
    this.repo = new NotificationsRepo(deps.db as never);
  }

  /**
   * adminId владельца (superadmin) тенанта — чтобы NotificationService мог
   * пропустить его в per-operator-рассылке (владельца обслуживает информер).
   */
  async resolveOwnerAdminId(tenantId: number): Promise<number | null> {
    return withTenant(this.deps.db, tenantId, async (tx) => {
      const repo = new NotificationsRepo(tx as never);
      const owner = await repo.resolveOwnerSettings(tenantId);
      return owner?.adminId ?? null;
    }).catch(() => null);
  }

  /** Удобные входы для существующих продюсеров. */
  async emitOpsAlert(alert: OpsAlert): Promise<void> {
    await this.emit(opsAlertToInformer(alert));
  }
  async emitNotificationEvent(event: NotificationEvent): Promise<void> {
    const ev = notificationEventToInformer(event, this.deps.appUrl);
    if (ev) await this.emit(ev);
  }

  async emit(event: InformerEvent): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Фаза 1 (в транзакции — admins под RLS): резолв владельца, дедуп, решение, запись ленты.
    const plan = await withTenant(this.deps.db, event.tenantId, async (tx) => {
      const repo = new NotificationsRepo(tx as never);
      const owner = await repo.resolveOwnerSettings(event.tenantId);
      if (!owner) return null;

      // Тема выключена → отбрасываем целиком (без записи в ленту).
      if (!topicEnabled(owner.settings, event.topic)) return null;

      const chatId = owner.settings?.telegramChatId ?? null;
      // Нет канала доставки и событие не critical (для critical есть email-гарантия) → пропускаем.
      if (!chatId && event.severity !== "critical") return null;

      // Persisted-дедуп (анти-шторм).
      const recent = await repo.findRecentByDedup(event.tenantId, event.dedupKey, now - this.cooldownSec);
      if (recent) return null;

      const level = (owner.settings?.informerLevel ?? "important") as InformerLevel;
      const realtime =
        !isMuted(owner.settings, now) && passesThreshold(event.severity, level);

      const rowId = await repo.insertAdminNotification({
        tenantId: event.tenantId,
        adminId: owner.adminId,
        topic: event.topic,
        severity: event.severity,
        kind: event.kind,
        title: event.title,
        body: event.detail,
        dedupKey: event.dedupKey,
        targetChatId: chatId,
        // delivered_at проставим ПОСЛЕ успешной реалтайм-доставки.
      });
      return { rowId, chatId, email: owner.email, realtime } satisfies DeliveryPlan;
    }).catch((err) => {
      this.deps.log?.warn?.("[informer] resolve/insert failed", {
        tenantId: event.tenantId,
        err: String(err),
      });
      return null;
    });

    if (!plan) return;

    // Фаза 2 (вне транзакции — сеть): реалтайм Telegram + email-для-critical.
    let delivered = false;
    if (plan.realtime && this.telegram && plan.chatId) {
      try {
        await this.telegram.send(plan.chatId, this.renderHtml(event));
        delivered = true;
      } catch (err) {
        this.deps.log?.warn?.("[informer] telegram send failed", {
          chatId: plan.chatId,
          err: String(err),
        });
      }
    }

    // critical → email-гарантия (даже если Telegram не настроен/упал). Перенесено из OpsAlertRouter.
    if (event.severity === "critical" && this.deps.email && plan.email) {
      try {
        await this.deps.email.send({
          to: plan.email,
          subject: `[critical] ${event.title}`,
          html: this.renderEmailHtml(event),
        });
        delivered = true;
      } catch (err) {
        this.deps.log?.warn?.("[informer] email send failed", { to: plan.email, err: String(err) });
      }
    }

    // Доставлено → исключаем из дайджеста.
    if (delivered) {
      await this.repo
        .markNotificationDelivered(plan.rowId, now)
        .catch((err) =>
          this.deps.log?.warn?.("[informer] mark delivered failed", {
            rowId: plan.rowId,
            err: String(err),
          }),
        );
    }

    this.deps.log?.info?.("[informer] routed", {
      tenantId: event.tenantId,
      kind: event.kind,
      topic: event.topic,
      severity: event.severity,
      realtime: plan.realtime,
      delivered,
    });
  }

  private renderHtml(event: InformerEvent): string {
    let msg = `${SEV_EMOJI[event.severity]} ${TOPIC_EMOJI[event.topic]} <b>${escapeHtml(event.title)}</b>`;
    if (event.detail) msg += `\n\n${escapeHtml(event.detail)}`;
    if (event.url) msg += `\n\n<a href="${escapeHtml(event.url)}">Открыть →</a>`;
    return msg;
  }

  private renderEmailHtml(event: InformerEvent): string {
    const color = "#dc2626"; // email шлём только для critical
    return `<!DOCTYPE html><html lang="ru"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="background:${color};padding:20px 28px;color:#fff;font-size:18px;font-weight:700">${SEV_EMOJI[event.severity]} ${escapeHtml(event.title)}</div>
    <div style="padding:24px 28px;color:#18181b;font-size:15px;line-height:1.6">
      <p style="margin:0 0 16px">${escapeHtml(event.detail)}</p>
      <a href="${escapeHtml(event.url ?? this.deps.appUrl)}" style="display:inline-block;padding:10px 20px;background:${color};color:#fff;border-radius:8px;font-weight:600;text-decoration:none">Открыть админку →</a>
    </div>
    <div style="padding:16px 28px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:12px;color:#a1a1aa">
      lead-engine · информер владельца · ${event.topic} / ${event.severity}
    </div>
  </div></body></html>`;
  }
}
