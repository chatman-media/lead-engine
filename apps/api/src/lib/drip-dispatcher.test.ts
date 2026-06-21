import { describe, expect, it } from "bun:test";
import type { Db } from "@chatman-media/conversation-engine";
import { dripDispatchTick } from "./drip-dispatcher.ts";

describe("dripDispatchTick", () => {
  it("ошибка dispatchTenant → проглатывается + log.warn (lines 42-44)", async () => {
    const warnings: string[] = [];
    // select → список активных тенантов; transaction → бросает (withTenant падает
    // внутри dispatchTenant → catch в цикле).
    const db = {
      select: () => ({
        from: () => ({ where: async () => [{ id: 5 }] }),
      }),
      transaction: async () => {
        throw new Error("tx boom");
      },
    } as unknown as Db;

    await dripDispatchTick(db, {
      nowSec: 1000,
      log: { warn: (m) => warnings.push(m) },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("drip-dispatcher tenant=5");
    expect(warnings[0]).toContain("tx boom");
  });

  it("нет активных тенантов → no-op", async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as unknown as Db;
    await expect(dripDispatchTick(db, { nowSec: 1 })).resolves.toBeUndefined();
  });
});
