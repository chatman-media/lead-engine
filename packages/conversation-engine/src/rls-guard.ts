import { sql } from "drizzle-orm";
import type { Db } from "./dal/types.ts";

export interface RlsRoleCheck {
  /** current_user в этом connection'е. */
  role: string;
  /** rolsuper — superuser bypass'ит RLS всегда. */
  isSuperuser: boolean;
  /** rolbypassrls — explicit BYPASSRLS attribute. */
  hasBypassRls: boolean;
  /** Resultant: будет ли RLS реально enforce'иться для этой роли. */
  isEnforced: boolean;
}

/**
 * Возвращает информацию о том, enforce'ится ли RLS на текущем connection'е.
 * apps/api / apps/worker зовут это в boot и логируют warning если RLS
 * по факту выключен (superuser / BYPASSRLS).
 *
 * Миграция 0004 включает FORCE ROW LEVEL SECURITY на всех tenant-scoped
 * таблицах, но Postgres exempt'ит superuser-роли и роли с BYPASSRLS=true.
 * Production deploy ДОЛЖЕН использовать ordinary role'ью (NOSUPERUSER
 * NOBYPASSRLS) — иначе RLS бесполезен как defense-in-depth.
 */
export async function checkRlsEnforcement(db: Db): Promise<RlsRoleCheck> {
  const rows = (await db.execute(sql`
    SELECT current_user::text AS role,
           rolsuper            AS issuper,
           rolbypassrls        AS hasbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `)) as unknown as Array<{ role: string; issuper: boolean; hasbypassrls: boolean }>;
  const r = rows[0];
  if (!r) {
    // Не должно случиться (current_user всегда есть в pg_roles), но
    // fail-safe: считаем что RLS НЕ enforce'ится, чтобы surface anomaly.
    return {
      role: "<unknown>",
      isSuperuser: false,
      hasBypassRls: false,
      isEnforced: false,
    };
  }
  return {
    role: r.role,
    isSuperuser: Boolean(r.issuper),
    hasBypassRls: Boolean(r.hasbypassrls),
    isEnforced: !r.issuper && !r.hasbypassrls,
  };
}
