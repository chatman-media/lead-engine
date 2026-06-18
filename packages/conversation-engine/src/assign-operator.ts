import { admins, conversations, operatorSettings } from "@chatman-media/storage";
import { and, count, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "./dal/types.ts";

/** Выбранный оператор: id админа + человекочитаемая метка для UI/топика. */
export interface PickedOperator {
  adminId: number;
  label: string;
}

/**
 * Метка оператора: имя, иначе @local-part email, иначе «оператор #id».
 * Приватные поля (chat_id и т.п.) не используются.
 */
export function operatorLabel(row: {
  name: string | null;
  email: string;
  adminId: number;
}): string {
  const name = row.name?.trim();
  if (name) return name;
  const local = row.email.split("@")[0]?.trim();
  if (local) return `@${local}`;
  return `оператор #${row.adminId}`;
}

/**
 * Наименее загруженный оператор тенанта (least-busy балансировка) — #694.
 *
 * Кандидаты — админы с записью operator_settings. При requireTelegram=true
 * (handoff в Telegram-форум, #651 — нужно куда слать) дополнительно требуется
 * привязанный telegram_chat_id. Нагрузка = число активных (не resolved)
 * диалогов, назначенных на оператора. Тай-брейк по adminId — детерминированно
 * для тестов/прода. Возвращает null, если подходящих операторов нет (caller
 * оставляет диалог без назначения).
 */
export async function pickLeastBusyOperator(
  tx: Db,
  tenantId: number,
  opts?: { requireTelegram?: boolean },
): Promise<PickedOperator | null> {
  const candidates = await tx
    .select({
      adminId: operatorSettings.adminId,
      name: admins.name,
      email: admins.email,
    })
    .from(operatorSettings)
    .innerJoin(admins, eq(admins.id, operatorSettings.adminId))
    .where(
      opts?.requireTelegram
        ? and(eq(operatorSettings.tenantId, tenantId), isNotNull(operatorSettings.telegramChatId))
        : eq(operatorSettings.tenantId, tenantId),
    );
  if (candidates.length === 0) return null;

  // Текущая нагрузка: активные (не resolved) диалоги на оператора.
  const loadRows = await tx
    .select({ adminId: conversations.assignedAdminId, open: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        isNotNull(conversations.assignedAdminId),
        ne(conversations.status, "resolved"),
      ),
    )
    .groupBy(conversations.assignedAdminId);
  const load = new Map<number, number>();
  for (const row of loadRows) {
    if (row.adminId != null) load.set(row.adminId, Number(row.open));
  }

  let best: PickedOperator | null = null;
  let bestLoad = Number.POSITIVE_INFINITY;
  // Детерминированный тай-брейк по adminId.
  for (const c of [...candidates].sort((a, b) => a.adminId - b.adminId)) {
    const busy = load.get(c.adminId) ?? 0;
    if (busy < bestLoad) {
      bestLoad = busy;
      best = {
        adminId: c.adminId,
        label: operatorLabel({
          name: c.name,
          email: c.email,
          adminId: c.adminId,
        }),
      };
    }
  }
  return best;
}
