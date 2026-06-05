/**
 * Operations-алерты владельцу (#145). Доставка операционных алертов обменника
 * (резкие колебания курса, устаревший фид, зависшие заявки, упавшие каналы,
 * всплеск оборота) человеку, который НЕ сидит в админке.
 *
 * Источники алертов (sink-и): operations-watcher (apps/worker) и рыночный фид
 * (apps/api). Оба строят OpsAlert и зовут OpsAlertRouter.emit().
 *
 * Маршрутизация по severity:
 *   critical → личный Telegram владельца + email (немедленно; email — гарантия,
 *              даже если Telegram не настроен/упал);
 *   warning  → Telegram (email только как fallback, если Telegram не доставлен);
 *   info     → Telegram (дайджест — возможный follow-up).
 *
 * Анти-шторм: in-memory cooldown на (tenant, dedupKey). Не переживает рестарт
 * процесса (тогда возможен один повторный алерт — это не шторм).
 *
 * Зависимости (TelegramClient, email-отправитель) инжектятся — пакет остаётся
 * без app-зависимостей.
 */

import { TelegramClient } from "@chatman-media/channel-telegram";
import { admins, operatorSettings, tenants } from "@chatman-media/storage";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "./dal/types.ts";
import { withTenant } from "./with-tenant.ts";

export type OpsAlertKind =
  | "rate_anomaly"
  | "rate_feed_stale"
  | "order_stuck"
  | "channel_down"
  | "volume_spike";

export type OpsSeverity = "critical" | "warning" | "info";

export interface OpsAlert {
  tenantId: number;
  kind: OpsAlertKind;
  severity: OpsSeverity;
  title: string;
  detail: string;
  /** Уникален для конкретного условия — основа cooldown/анти-шторма. */
  dedupKey: string;
}

export interface OpsAlertSink {
  emit(alert: OpsAlert): Promise<void>;
}

/** Минимальный контракт отправителя email (Mailer из apps/api ему соответствует). */
export interface OpsEmailSender {
  send(opts: { to: string; subject: string; html: string }): Promise<void>;
}

/** Контракт отправителя Telegram (по умолчанию строится из botToken; инжектится в тестах). */
export interface OpsTelegramSender {
  send(chatId: string, htmlText: string): Promise<void>;
}

export interface OwnerContacts {
  email: string | null;
  slug: string | null;
  telegramChatIds: string[];
}

export interface OpsAlertRouterDeps {
  db: Db;
  /** Токен operator-бота (PLATFORM_OPERATOR_BOT_TOKEN). Пусто → Telegram отключён. */
  botToken: string;
  appUrl: string;
  /** Отправитель email. null → email-канал отключён. */
  email?: OpsEmailSender | null;
  /** Override отправителя Telegram (для тестов). По умолчанию строится из botToken. */
  telegram?: OpsTelegramSender | null;
  /** Анти-шторм: не повторять один (tenant, dedupKey) чаще, мс. Default 30 мин. */
  cooldownMs?: number;
  log?: { warn?: (msg: string, ctx?: unknown) => void; info?: (msg: string, ctx?: unknown) => void };
}

const SEVERITY_EMOJI: Record<OpsSeverity, string> = {
  critical: "🔴",
  warning: "🟡",
  info: "ℹ️",
};

function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Резолвит контакты владельца тенанта: email супер-админа + Telegram-чаты операторов. */
export async function resolveOwnerContacts(db: Db, tenantId: number): Promise<OwnerContacts> {
  return withTenant(db, tenantId, async (tx) => {
    const [owner] = await tx
      .select({ email: admins.email, slug: tenants.slug })
      .from(admins)
      .innerJoin(tenants, eq(tenants.id, admins.tenantId))
      .where(and(eq(admins.tenantId, tenantId), eq(admins.role, "superadmin")))
      .limit(1);
    const chats = await tx
      .select({ chatId: operatorSettings.telegramChatId })
      .from(operatorSettings)
      .where(
        and(eq(operatorSettings.tenantId, tenantId), isNotNull(operatorSettings.telegramChatId)),
      );
    return {
      email: owner?.email ?? null,
      slug: owner?.slug ?? null,
      telegramChatIds: chats.map((c) => c.chatId).filter((x): x is string => !!x),
    };
  });
}

export class OpsAlertRouter implements OpsAlertSink {
  private readonly telegram: OpsTelegramSender | null;
  private readonly cooldownMs: number;
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly deps: OpsAlertRouterDeps) {
    if (deps.telegram !== undefined) {
      this.telegram = deps.telegram;
    } else if (deps.botToken) {
      const client = new TelegramClient({ token: deps.botToken });
      this.telegram = {
        send: (chatId, htmlText) =>
          client.sendMessage({ chatId, text: htmlText, parseMode: "HTML" }).then(() => undefined),
      };
    } else {
      this.telegram = null;
    }
    this.cooldownMs = deps.cooldownMs ?? 30 * 60_000;
  }

  private suppressed(alert: OpsAlert, nowMs: number): boolean {
    const key = `${alert.tenantId}:${alert.dedupKey}`;
    const last = this.lastAt.get(key);
    if (last !== undefined && nowMs - last < this.cooldownMs) return true;
    this.lastAt.set(key, nowMs);
    return false;
  }

  async emit(alert: OpsAlert): Promise<void> {
    if (this.suppressed(alert, Date.now())) return;

    const owner = await resolveOwnerContacts(this.deps.db, alert.tenantId).catch((err) => {
      this.deps.log?.warn?.("[ops-alerts] owner resolve failed", { tenantId: alert.tenantId, err: String(err) });
      return null;
    });
    if (!owner) return;

    // 1. Telegram — личные чаты владельца/операторов.
    let telegramDelivered = false;
    if (this.telegram && owner.telegramChatIds.length > 0) {
      const text =
        `${SEVERITY_EMOJI[alert.severity]} <b>${escapeHtml(alert.title)}</b>\n\n` +
        `${escapeHtml(alert.detail)}`;
      for (const chatId of owner.telegramChatIds) {
        try {
          await this.telegram.send(chatId, text);
          telegramDelivered = true;
        } catch (err) {
          this.deps.log?.warn?.("[ops-alerts] telegram send failed", { chatId, err: String(err) });
        }
      }
    }

    // 2. Email — для critical всегда; для warning/info — только как fallback.
    const emailNeeded = alert.severity === "critical" || (!telegramDelivered && alert.severity !== "info");
    let emailDelivered = false;
    if (emailNeeded && this.deps.email && owner.email) {
      try {
        await this.deps.email.send({
          to: owner.email,
          subject: `[${alert.severity}] ${alert.title} — обменник`,
          html: renderOpsEmailHtml(alert, this.deps.appUrl),
        });
        emailDelivered = true;
      } catch (err) {
        this.deps.log?.warn?.("[ops-alerts] email send failed", { to: owner.email, err: String(err) });
      }
    }

    this.deps.log?.info?.("[ops-alerts] routed", {
      tenantId: alert.tenantId,
      kind: alert.kind,
      severity: alert.severity,
      telegramDelivered,
      emailDelivered,
    });
  }
}

/** Самодостаточный HTML операционного алерта (без зависимости от шаблонов apps/api). */
export function renderOpsEmailHtml(alert: OpsAlert, appUrl: string): string {
  const color = alert.severity === "critical" ? "#dc2626" : alert.severity === "warning" ? "#d97706" : "#2563eb";
  return `<!DOCTYPE html><html lang="ru"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="background:${color};padding:20px 28px;color:#fff;font-size:18px;font-weight:700">${SEVERITY_EMOJI[alert.severity]} ${escapeHtml(alert.title)}</div>
    <div style="padding:24px 28px;color:#18181b;font-size:15px;line-height:1.6">
      <p style="margin:0 0 16px">${escapeHtml(alert.detail)}</p>
      <a href="${appUrl}" style="display:inline-block;padding:10px 20px;background:${color};color:#fff;border-radius:8px;font-weight:600;text-decoration:none">Открыть админку →</a>
    </div>
    <div style="padding:16px 28px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:12px;color:#a1a1aa">
      lead-engine · операционный алерт обменника · severity: ${alert.severity}
    </div>
  </div></body></html>`;
}

/** Тонкий транспорт Resend для apps/worker (apps/api использует свой Mailer). */
export class ResendEmailSender implements OpsEmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(opts: { to: string; subject: string; html: string }): Promise<void> {
    if (!this.apiKey) {
      console.log(`[resend] dry-run (no key) → to=${opts.to} subject="${opts.subject}"`);
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [opts.to], subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      throw new Error(`Resend error ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }
}
