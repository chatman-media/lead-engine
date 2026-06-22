// Чистый unit (без PG) для lookup-методов NotificationsRepo, которые
// интеграция не покрывает (findOperatorSettingsByChatId / findForumRuleByTargetId).

import { describe, expect, it } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NotificationsRepo } from "./notifications.ts";

function fakeDb(rows: unknown[]): PostgresJsDatabase {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: async () => rows,
  };
  return { select: () => node } as unknown as PostgresJsDatabase;
}

describe("NotificationsRepo.findOperatorSettingsByChatId", () => {
  it("возвращает первую строку", async () => {
    const repo = new NotificationsRepo(fakeDb([{ adminId: 5, telegramChatId: "c1" }]));
    const row = await repo.findOperatorSettingsByChatId("c1");
    expect(row).toMatchObject({ adminId: 5 });
  });

  it("нет строк → undefined", async () => {
    const repo = new NotificationsRepo(fakeDb([]));
    expect(await repo.findOperatorSettingsByChatId("none")).toBeUndefined();
  });
});

describe("NotificationsRepo.findForumRuleByTargetId", () => {
  it("возвращает {tenantId, ruleId} первого активного форум-правила", async () => {
    const repo = new NotificationsRepo(fakeDb([{ tenantId: 9, ruleId: 3 }]));
    expect(await repo.findForumRuleByTargetId("-100500")).toEqual({ tenantId: 9, ruleId: 3 });
  });

  it("нет правил → undefined", async () => {
    const repo = new NotificationsRepo(fakeDb([]));
    expect(await repo.findForumRuleByTargetId("-100500")).toBeUndefined();
  });
});
