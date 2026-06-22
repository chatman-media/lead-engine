// Чистые хелперы оператор-бота, вынесенные из operator-bot-handler.ts, чтобы
// их могли переиспользовать модули exchange-side-effects и сам handler без
// дублирования и циклических импортов (зависимость строго handler → shared).

/** TTL кода выдачи (payout code) — 1 час. */
export const PAYOUT_CODE_TTL_SEC = 60 * 60;

/**
 * Черновик ответа оператора, ожидающий подтверждения/отправки. Живёт здесь
 * (а не в handler), чтобы exchange-side-effects могли типизировать `tx`-операции
 * без циклического импорта из operator-bot-handler.
 */
export interface PendingOperatorDraft {
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
}

/** "2h" / "30m" / "1d" → секунды; "off"/"0"/"" → 0; мусор → null. */
export function parseMuteSeconds(arg: string): number | null {
  const a = arg.trim().toLowerCase();
  if (!a || a === "off" || a === "0") return 0;
  const m = /^(\d+)\s*(m|h|d)$/.exec(a);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 10);
  const unit = m[2];
  return unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
}

export function escapeHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function pickupWindowFromDestination(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const obj = objectValue(parsed);
    return (
      stringValue(obj.pickupWindow) ??
      stringValue(obj.pickup_window) ??
      stringValue(obj.window) ??
      stringValue(obj.timeWindow) ??
      stringValue(obj.time_window) ??
      stringValue(obj.slot)
    );
  } catch {
    return null;
  }
}
