/**
 * Общая логика бана/разбана контакта. Бан — операция над contact.attributesJson
 * (inbound pipeline не генерирует ответы для isBanned-контакта). Триггерится из
 * двух мест: карточки лида (admin-leads) и диалога (admin-conversations), поэтому
 * мутация атрибутов и чтение состояния живут здесь, чтобы не разъезжались.
 */

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True, если контакт сейчас в бане (по любому из исторических признаков). */
export function isContactBanned(attributesJson: string | null | undefined): boolean {
  const attrs = parseJsonObject(attributesJson);
  const ban = objectValue(attrs.ban);
  const moderation = objectValue(attrs.moderation);
  return (
    attrs.isBanned === true ||
    attrs.banStatus === "banned" ||
    ban.status === "banned" ||
    ban.banned === true ||
    moderation.status === "banned"
  );
}

export interface ContactBanState {
  banned: boolean;
  reason: string | null;
  bannedAt: number | null;
}

/** Состояние бана для отдачи в UI (список диалогов / карточка). */
export function contactBanState(attributesJson: string | null | undefined): ContactBanState {
  const attrs = parseJsonObject(attributesJson);
  const ban = objectValue(attrs.ban);
  return {
    banned: isContactBanned(attributesJson),
    reason: stringValue(ban.reason) ?? stringValue(attrs.banReason),
    bannedAt: numberValue(ban.bannedAt) ?? numberValue(attrs.bannedAt),
  };
}

export interface BanOpts {
  adminId?: number | null;
  reason?: string | null;
  now: number;
  /** Откуда инициирован бан: "admin_lead_detail" | "admin_inbox" и т.п. */
  source: string;
}

/** Возвращает новый attributesJson с проставленными признаками бана. */
export function buildBannedAttributes(
  attributesJson: string | null | undefined,
  opts: BanOpts,
): string {
  const attrs = parseJsonObject(attributesJson);
  const currentBan = objectValue(attrs.ban);
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : null;
  const nextBan = {
    ...currentBan,
    status: "banned",
    banned: true,
    bannedByAdminId: opts.adminId ?? null,
    bannedAt: opts.now,
    reason,
    source: opts.source,
  };
  const nextAttrs = {
    ...attrs,
    isBanned: true,
    banStatus: "banned",
    bannedAt: opts.now,
    bannedByAdminId: opts.adminId ?? null,
    banReason: reason,
    ban: nextBan,
  };
  return JSON.stringify(nextAttrs);
}

export interface UnbanResult {
  attributesJson: string;
  wasBanned: boolean;
  previousReason: string | null;
  previousBannedAt: number | null;
}

/** Возвращает новый attributesJson со снятым баном + сводку о прошлом состоянии. */
export function buildUnbannedAttributes(
  attributesJson: string | null | undefined,
  opts: { adminId?: number | null; now: number },
): UnbanResult {
  const attrs = parseJsonObject(attributesJson);
  const currentBan = objectValue(attrs.ban);
  const moderation = objectValue(attrs.moderation);
  const wasBanned = isContactBanned(attributesJson);
  const previousReason = stringValue(currentBan.reason) ?? stringValue(attrs.banReason);
  const previousBannedAt = numberValue(currentBan.bannedAt) ?? numberValue(attrs.bannedAt);
  const nextBan = {
    ...currentBan,
    status: "unbanned",
    banned: false,
    unbannedByAdminId: opts.adminId ?? null,
    unbannedAt: opts.now,
  };
  const nextAttrs: Record<string, unknown> = {
    ...attrs,
    isBanned: false,
    banStatus: "unbanned",
    unbannedAt: opts.now,
    unbannedByAdminId: opts.adminId ?? null,
    ban: nextBan,
  };
  if (moderation.status === "banned") {
    nextAttrs.moderation = { ...moderation, status: "cleared" };
  }
  return {
    attributesJson: JSON.stringify(nextAttrs),
    wasBanned,
    previousReason,
    previousBannedAt,
  };
}
