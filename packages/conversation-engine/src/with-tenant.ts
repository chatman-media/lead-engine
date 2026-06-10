import { sql } from "drizzle-orm";
import type { Db } from "./dal/types.ts";

/**
 * Открывает транзакцию, выставляет `SET LOCAL app.tenant_id = <id>` (для
 * Postgres RLS-policy `tenant_isolation`), потом вызывает `fn(tx)`.
 *
 * RLS-policies в миграции 0004 сравнивают `tenant_id` колонку с
 * `current_setting('app.tenant_id', true)::int`. Без SET LOCAL var = NULL
 * → policy всегда false → 0 видимых строк (fail-safe).
 *
 * Использование в apps/api / apps/worker:
 *   const result = await withTenant(db, tenantId, async (tx) => {
 *     const repo = new ContactsRepo({ db: tx, tenantId });
 *     return repo.byId(42);
 *   });
 *
 * `tx` имеет тот же тип что `Db` (Drizzle PostgresJsDatabase) — repo-методы
 * принимают его без изменений. SET LOCAL scoped в транзакцию: после COMMIT
 * setting сбрасывается, connection возвращается в pool clean.
 *
 * Idempotent при nested-вызовах: вложенный withTenant с тем же tenantId
 * просто переоткроет SET LOCAL (no-op effectively); с разным — переопределит
 * (caller responsibility — не делать так без чёткого понимания).
 */
export async function withTenant<T>(
	db: Db,
	tenantId: number,
	fn: (tx: Db) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		// SET LOCAL не принимает параметризованный bind в Postgres protocol,
		// но tenantId — integer (валидируется TS), без SQL-injection risk.
		await tx.execute(sql.raw(`SET LOCAL app.tenant_id = ${tenantId}`));
		return fn(tx as unknown as Db);
	});
}
