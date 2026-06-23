/**
 * Audit-log helper. Каждое admin-action (PUT/POST/DELETE через admin-API)
 * пишется в audit_log row с tenantId + adminId + action + targetKind +
 * detailsJson.
 *
 * Использование:
 *   await recordAudit(db, {
 *     tenantId, adminId,
 *     action: "llm_config.upsert",
 *     targetKind: "llm_provider_config",
 *     targetId: "chat",
 *     details: { provider: "openai", model: "gpt-4o-mini", hasSecret: true },
 *   });
 *
 * Fail-quiet: error в audit logging не должна fail'ить основной запрос
 * (исключение в business-handler'е оставляет audit без записи; не наоборот).
 */

import { type Db } from "@chatman-media/conversation-engine";
import { auditLog } from "@chatman-media/storage";

export interface AuditEntry {
  tenantId: number;
  adminId?: number;
  action: string;
  targetKind?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
}

export async function recordAudit(
  db: Db,
  entry: AuditEntry,
  onError?: (err: unknown, entry: AuditEntry) => void,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      tenantId: entry.tenantId,
      ...(entry.adminId !== undefined ? { adminId: entry.adminId } : {}),
      action: entry.action,
      ...(entry.targetKind ? { targetKind: entry.targetKind } : {}),
      ...(entry.targetId !== undefined ? { targetId: String(entry.targetId) } : {}),
      ...(entry.details ? { detailsJson: JSON.stringify(entry.details) } : {}),
      createdAt: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    // Audit failure НЕ должна валить request — log + swallow.
    onError?.(err, entry);
  }
}
