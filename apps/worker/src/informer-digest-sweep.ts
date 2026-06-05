/**
 * Informer-digest-sweep — периодическая сводка владельцу тенанта по накопленным
 * событиям, которые НЕ ушли в реалтайм (delivered_at IS NULL): рутина при
 * пороге important/critical, всё — при silent, плюс то, что пришло во время мута.
 *
 * Источник — лента admin_notifications (пишет AdminInformer). По расписанию
 * владельца (informer_digest: off|daily|shift, час informer_digest_hour в
 * informer_tz) собираем pending-строки, рендерим компактную сводку, шлём в
 * личный Telegram владельца (тот же operator-бот), помечаем строки digested и
 * штампуем informer_last_digest_at.
 *
 * Паттерн (run/sweep/per-tenant, AbortSignal) — как OperationsWatchSweeper.
 */

import { TelegramClient } from "@chatman-media/channel-telegram";
import {
  type AdminNotificationRow,
  type Db,
  NotificationsRepo,
  withTenant,
} from "@chatman-media/conversation-engine";
import { conversations, tenants } from "@chatman-media/storage";
import { and, count, eq } from "drizzle-orm";

export interface InformerDigestSender {
  send(chatId: string, htmlText: string): Promise<void>;
}

export interface InformerDigestOpts {
  intervalMs: number;
  /** Токен operator-бота. Пусто → digest отключён (нечем слать). */
  botToken: string;
  /** Override отправителя (для тестов). undefined → строится из botToken. */
  sender?: InformerDigestSender | null;
}

interface DigestSettings {
  informerDigest: string;
  informerDigestHour: number;
  informerTz: string;
  informerLastDigestAt: number | null;
}

export class InformerDigestSweeper {
  private stopped = false;
  private readonly sender: InformerDigestSender | null;

  constructor(
    private readonly db: Db,
    private readonly opts: InformerDigestOpts,
  ) {
    if (opts.sender !== undefined) {
      this.sender = opts.sender;
    } else if (opts.botToken) {
      const client = new TelegramClient({ token: opts.botToken });
      this.sender = {
        send: (chatId, html) =>
          client
            .sendMessage({ chatId, text: html, parseMode: "HTML", disableWebPagePreview: true })
            .then(() => undefined),
      };
    } else {
      this.sender = null;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener("abort", () => {
      this.stopped = true;
    });
    while (!this.stopped) {
      try {
        await this.sweep();
      } catch (err) {
        console.error("[informer-digest] error", err);
      }
      await new Promise((r) => setTimeout(r, this.opts.intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async sweep(): Promise<void> {
    const activeTenants = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, "active"));
    const now = Math.floor(Date.now() / 1000);
    for (const { id } of activeTenants) {
      await this.sweepTenant(id, now).catch((err) =>
        console.error(`[informer-digest] tenant=${id}`, err),
      );
    }
  }

  async sweepTenant(tenantId: number, now: number): Promise<void> {
    // Фаза 1 (в транзакции — admins/conversations под RLS): резолв, проверка
    // расписания, сбор pending + живой счётчик эскалаций.
    const plan = await withTenant(this.db, tenantId, async (tx) => {
      const repo = new NotificationsRepo(tx as never);
      const owner = await repo.resolveOwnerSettings(tenantId);
      const chatId = owner?.settings?.telegramChatId;
      if (!owner || !chatId) return null;
      if (!isDigestDue(owner.settings as DigestSettings, now)) return null;

      const pending = await repo.listPendingDigest(tenantId, owner.adminId);
      if (pending.length === 0) return null;

      const [esc] = await tx
        .select({ n: count(conversations.id) })
        .from(conversations)
        .where(and(eq(conversations.tenantId, tenantId), eq(conversations.mode, "human")));

      return { adminId: owner.adminId, chatId, pending, escalations: esc?.n ?? 0 };
    });
    if (!plan) return;

    // Фаза 2 (вне транзакции — сеть): отправка.
    const html = renderDigest(plan.pending, plan.escalations);
    if (this.sender) {
      try {
        await this.sender.send(plan.chatId, html);
      } catch (err) {
        // Не маркаем — повторим в следующий свип (last_digest_at не двигаем).
        console.error(`[informer-digest] send failed tenant=${tenantId}`, err);
        return;
      }
    }

    // Фаза 3: штамп (no-RLS таблицы — без withTenant).
    const repo = new NotificationsRepo(this.db as never);
    await repo.markDigested(
      plan.pending.map((p) => p.id),
      now,
    );
    await repo.updateInformerPrefs(plan.adminId, { informerLastDigestAt: now });
  }
}

// ── Расписание ──────────────────────────────────────────────────────────────

/** Локальные год-месяц-день + час в указанном tz (fallback UTC при кривом tz). */
function localParts(epochSec: number, tz: string): { day: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(epochSec * 1000));
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(epochSec * 1000));
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = Number.parseInt(get("hour"), 10);
  if (hour === 24 || Number.isNaN(hour)) hour = 0; // en-CA отдаёт 24 для полуночи
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour };
}

/**
 * Пора ли слать дайджест. daily — раз в локальный день в/после digestHour;
 * shift — дважды (digestHour и +12ч). Робастно к интервалу свипа: ключ слота
 * сравнивается с last_digest_at, поэтому даже редкий свип не дублирует.
 */
export function isDigestDue(s: DigestSettings, now: number): boolean {
  if (s.informerDigest === "off") return false;
  const tz = s.informerTz || "UTC";
  const cur = localParts(now, tz);
  const last = s.informerLastDigestAt ? localParts(s.informerLastDigestAt, tz) : null;
  const hour = ((s.informerDigestHour % 24) + 24) % 24;

  if (s.informerDigest === "daily") {
    if (cur.hour < hour) return false;
    return !last || last.day !== cur.day;
  }

  // shift: два слота за день.
  const other = (hour + 12) % 24;
  const s1 = Math.min(hour, other);
  const s2 = Math.max(hour, other);
  const slotOf = (h: number) => (h >= s2 ? 1 : h >= s1 ? 0 : -1);
  const curSlot = slotOf(cur.hour);
  if (curSlot < 0) return false;
  const curKey = `${cur.day}:${curSlot}`;
  const lastKey = last ? `${last.day}:${slotOf(last.hour)}` : null;
  return curKey !== lastKey;
}

// ── Рендер ────────────────────────────────────────────────────────────────

function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const TOPIC_LABEL: Record<string, string> = {
  leads: "🆕 Лиды",
  escalation: "🆘 Эскалации",
  orders: "💱 Заявки",
  system: "🛠 Система",
};

export function renderDigest(rows: AdminNotificationRow[], escalations: number): string {
  const byTopic = new Map<string, number>();
  for (const r of rows) byTopic.set(r.topic, (byTopic.get(r.topic) ?? 0) + 1);

  let msg = `📊 <b>Сводка</b> · накопилось ${rows.length}`;
  for (const [topic, n] of byTopic) {
    msg += `\n${TOPIC_LABEL[topic] ?? topic}: ${n}`;
  }

  const hot = rows.filter((r) => r.severity !== "info").slice(0, 5);
  if (hot.length > 0) {
    msg += "\n\n<b>Важное:</b>";
    for (const h of hot) {
      msg += `\n• ${escapeHtml(h.title)}${h.body ? ` — ${escapeHtml(h.body)}` : ""}`;
    }
  }

  if (escalations > 0) {
    msg += `\n\n🆘 Сейчас ждут оператора: <b>${escalations}</b>`;
  }
  return msg;
}
