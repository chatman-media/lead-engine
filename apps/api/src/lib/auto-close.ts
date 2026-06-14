/**
 * #632 — авто-закрытие диалогов после N часов тишины. Периодический тик: по
 * active-тенантам с заданным `botSettings.autocloseHours` переводит idle-диалоги
 * (last_message_at старше порога, status != resolved) в resolved. Оператор может
 * переоткрыть вручную. Шаблон — dripDispatchTick / replyDebounceTick.
 */
import {
  type BotSettings,
  ConversationsRepo,
  type Db,
  withTenant,
} from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";

export interface AutoCloseOpts {
  nowSec: number;
  resolveBotSettings: (tenantId: number) => Promise<BotSettings>;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export async function autoCloseTick(db: Db, opts: AutoCloseOpts): Promise<void> {
  const activeTenants = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id } of activeTenants) {
    try {
      const settings = await opts.resolveBotSettings(id);
      const hours = settings.autocloseHours;
      if (!hours || hours <= 0) continue;
      const cutoff = opts.nowSec - hours * 3600;
      const closed = await withTenant(db, id, async (tx) =>
        new ConversationsRepo({ db: tx, tenantId: id }).autoCloseIdle(cutoff),
      );
      if (closed > 0) {
        opts.log?.info?.(`auto-close tenant=${id}: closed ${closed} idle conversation(s)`);
      }
    } catch (err) {
      opts.log?.warn?.(
        `auto-close tenant=${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
