// Unit-тесты checkRlsEnforcement: маппинг pg_roles → RlsRoleCheck, включая
// fail-safe ветку «current_user не найден» (недостижимую на живом Postgres).

import { describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import { checkRlsEnforcement } from "./rls-guard.ts";

function dbExecuting(rows: unknown[]): Db {
  return { execute: async () => rows } as unknown as Db;
}

describe("checkRlsEnforcement", () => {
  it("обычная роль (NOSUPERUSER NOBYPASSRLS) → isEnforced=true", async () => {
    const res = await checkRlsEnforcement(
      dbExecuting([{ role: "app_rw", issuper: false, hasbypassrls: false }]),
    );
    expect(res).toEqual({
      role: "app_rw",
      isSuperuser: false,
      hasBypassRls: false,
      isEnforced: true,
    });
  });

  it("superuser → isEnforced=false", async () => {
    const res = await checkRlsEnforcement(
      dbExecuting([{ role: "postgres", issuper: true, hasbypassrls: false }]),
    );
    expect(res.isSuperuser).toBe(true);
    expect(res.isEnforced).toBe(false);
  });

  it("BYPASSRLS-роль → isEnforced=false", async () => {
    const res = await checkRlsEnforcement(
      dbExecuting([{ role: "etl", issuper: false, hasbypassrls: true }]),
    );
    expect(res.hasBypassRls).toBe(true);
    expect(res.isEnforced).toBe(false);
  });

  it("пустой результат → fail-safe <unknown> / isEnforced=false", async () => {
    const res = await checkRlsEnforcement(dbExecuting([]));
    expect(res).toEqual({
      role: "<unknown>",
      isSuperuser: false,
      hasBypassRls: false,
      isEnforced: false,
    });
  });
});
