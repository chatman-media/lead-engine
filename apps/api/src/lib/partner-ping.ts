/**
 * Partner ping — универсальный механизм уведомления партнёра
 * при входе лида на партнёрскую стадию.
 *
 * Поддерживает два транспорта:
 *   1. HTTP POST  — partner_webhook_url = "https://..."
 *      Payload:  { event, leadId, tenantSlug, stage, fields, callbackUrl, callbackToken }
 *
 *   2. Telegram   — partner_webhook_url = "tg://CHAT_ID"
 *      Отправляет структурированное сообщение с кнопками «✅ Подтвердить» /
 *      «❌ Отклонить», кликающими в callbackUrl. Партнёр отвечает сам (не бот).
 *
 * Callback flow:
 *   GET /api/partner/cb/:token?a=confirm  → advance lead to next stage
 *   GET /api/partner/cb/:token?a=cancel   → set lead state note, clear token
 *   GET /api/partner/cb/:token            → HTML page with two buttons
 *
 * Token format: base64url(JSON{leadId,stageId,ts}).HMAC-SHA256-hex
 */

import { signWebhookPayload } from "./webhook-sign.ts";

// ─── Token ─────────────────────────────────────────────────────────────────

export interface CallbackTokenPayload {
  leadId: number;
  stageId: number;
  ts: number; // epoch seconds (issued at)
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function parseB64url(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Создаёт подписанный токен для callback-верификации.
 * secret — из конфига (PARTNER_CALLBACK_SECRET или SESSION_SECRET).
 */
export async function makeCallbackToken(
  payload: CallbackTokenPayload,
  secret: string,
): Promise<string> {
  const header = b64url(JSON.stringify(payload));
  const hmac = await signWebhookPayload(header, secret);
  return `${header}.${hmac}`;
}

/**
 * Верифицирует токен и возвращает payload или null при неверной подписи.
 * Не проверяет TTL — токен действует до первого использования (cleared after callback).
 */
export async function verifyCallbackToken(
  token: string,
  secret: string,
): Promise<CallbackTokenPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const header = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = await signWebhookPayload(header, secret);
  if (provided !== expected) return null;
  const raw = parseB64url(header);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CallbackTokenPayload;
  } catch {
    return null;
  }
}

// ─── Ping ───────────────────────────────────────────────────────────────────

export interface PartnerPingOpts {
  webhookUrl: string;
  webhookMode: string; // 'fire_and_forget' | 'await_callback'
  leadId: number;
  stageId: number;
  tenantSlug: string;
  stageSlug: string;
  stageDisplayName: string;
  contactDisplayName: string | null;
  leadFields: Record<string, unknown>;
  appUrl: string;
  /** Operator bot token (PLATFORM_OPERATOR_BOT_TOKEN). Used for tg:// transport. */
  operatorBotToken: string;
  /** Secret for HMAC token signing. */
  callbackSecret: string;
}

export interface PartnerPingResult {
  token: string;
  transport: "http" | "telegram";
}

/**
 * Fires the partner ping and returns the callback token.
 * Does NOT update the database — caller stores the token.
 *
 * @throws if transport fails (caller should catch and log; not block lead advance).
 */
export async function firePartnerPing(
  opts: PartnerPingOpts,
): Promise<PartnerPingResult> {
  const ts = Math.floor(Date.now() / 1000);
  const token = await makeCallbackToken({ leadId: opts.leadId, stageId: opts.stageId, ts }, opts.callbackSecret);
  const confirmUrl = `${opts.appUrl}/api/partner/cb/${token}?a=confirm`;
  const cancelUrl = `${opts.appUrl}/api/partner/cb/${token}?a=cancel`;
  const pageUrl = `${opts.appUrl}/api/partner/cb/${token}`;

  if (opts.webhookUrl.startsWith("tg://")) {
    const chatId = opts.webhookUrl.slice("tg://".length).trim();
    if (!chatId) throw new Error("partner_webhook_url: tg:// has no chat_id");
    if (!opts.operatorBotToken) throw new Error("PLATFORM_OPERATOR_BOT_TOKEN not configured");
    await sendTelegramPartnerMessage({
      botToken: opts.operatorBotToken,
      chatId,
      leadId: opts.leadId,
      contactDisplayName: opts.contactDisplayName,
      stageDisplayName: opts.stageDisplayName,
      leadFields: opts.leadFields,
      confirmUrl,
      cancelUrl,
    });
    return { token, transport: "telegram" };
  }

  // HTTP POST
  const payload = {
    event: "lead.partner_handoff",
    leadId: opts.leadId,
    tenantSlug: opts.tenantSlug,
    stage: { slug: opts.stageSlug, displayName: opts.stageDisplayName },
    contact: { displayName: opts.contactDisplayName },
    fields: opts.leadFields,
    callbackUrl: pageUrl,
    actions: { confirm: confirmUrl, cancel: cancelUrl },
    callbackToken: token,
    issuedAt: ts,
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "LeadEngine-PartnerPing/1.0",
  };
  const res = await fetch(opts.webhookUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Partner webhook responded ${res.status}: ${text.slice(0, 200)}`);
  }
  return { token, transport: "http" };
}

// ─── Telegram helper ────────────────────────────────────────────────────────

interface TgSendOpts {
  botToken: string;
  chatId: string;
  leadId: number;
  contactDisplayName: string | null;
  stageDisplayName: string;
  leadFields: Record<string, unknown>;
  confirmUrl: string;
  cancelUrl: string;
}

async function sendTelegramPartnerMessage(opts: TgSendOpts): Promise<void> {
  // Format key fields as a readable list (skip internal/empty values)
  const SKIP_KEYS = new Set(["id", "tenantId", "userId", "createdAt", "updatedAt"]);
  const fieldLines = Object.entries(opts.leadFields)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && v != null && v !== "")
    .map(([k, v]) => `  • <b>${k}</b>: ${String(v)}`)
    .join("\n");

  const text =
    `<b>Новая заявка партнёру</b>\n\n` +
    `<b>Клиент:</b> ${opts.contactDisplayName ?? "—"}\n` +
    `<b>Стадия:</b> ${opts.stageDisplayName}\n` +
    `<b>Лид #${opts.leadId}</b>\n` +
    (fieldLines ? `\n<b>Данные заказа:</b>\n${fieldLines}\n` : "") +
    `\nПожалуйста, подтвердите или отклоните заявку:`;

  const body = JSON.stringify({
    chat_id: opts.chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Подтвердить", url: opts.confirmUrl },
          { text: "❌ Отклонить", url: opts.cancelUrl },
        ],
      ],
    },
  });

  const url = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { description?: string };
    throw new Error(`Telegram sendMessage failed ${res.status}: ${err.description ?? "unknown"}`);
  }
}
