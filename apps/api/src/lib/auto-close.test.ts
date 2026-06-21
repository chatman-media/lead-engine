import { describe, expect, it } from "bun:test";
import type { Db } from "@chatman-media/conversation-engine";
import { autoCloseTick } from "./auto-close.ts";

function dbWithTenants(ids: number[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => ids.map((id) => ({ id })),
      }),
    }),
  } as unknown as Db;
}

describe("autoCloseTick", () => {
  it("ошибка resolveBotSettings по тенанту → проглатывается + log.warn (lines 39-41)", async () => {
    const warnings: string[] = [];
    await autoCloseTick(dbWithTenants([7]), {
      nowSec: 1000,
      resolveBotSettings: async () => {
        throw new Error("settings down");
      },
      log: { warn: (m) => warnings.push(m) },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("auto-close tenant=7");
    expect(warnings[0]).toContain("settings down");
  });

  it("autocloseHours не задан → continue без падения", async () => {
    let warned = false;
    await autoCloseTick(dbWithTenants([1]), {
      nowSec: 1000,
      resolveBotSettings: async () =>
        ({ autocloseHours: 0 }) as Awaited<
          ReturnType<Parameters<typeof autoCloseTick>[1]["resolveBotSettings"]>
        >,
      log: {
        warn: () => {
          warned = true;
        },
      },
    });
    expect(warned).toBe(false);
  });

  it("нет активных тенантов → no-op", async () => {
    await expect(
      autoCloseTick(dbWithTenants([]), {
        nowSec: 1,
        resolveBotSettings: async () => {
          throw new Error("should not be called");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
