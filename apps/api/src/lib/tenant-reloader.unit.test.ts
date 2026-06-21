// Чистый unit для reloadChannels: ветки webRegistry/userbotRegistry (lines
// 114, 117). db.select(slug) фейкается; реестры — заглушки с reloadTenant.

import { describe, expect, it } from "bun:test";
import type { Db } from "@chatman-media/conversation-engine";
import { makeTenantReloader, type TenantReloaderOpts } from "./tenant-reloader.ts";

function baseOpts(over: Partial<TenantReloaderOpts>): TenantReloaderOpts {
  return {
    db: {
      select: () => ({
        from: () => ({ where: async () => [{ slug: "acme" }] }),
      }),
    } as unknown as Db,
    cfg: { masterKeyHex: "x" } as TenantReloaderOpts["cfg"],
    ref: {} as TenantReloaderOpts["ref"],
    registry: {
      reloadTenant: async () => {},
      getTelegramBotsByTenant: () => [],
    } as unknown as TenantReloaderOpts["registry"],
    log: () => {},
    ...over,
  };
}

describe("makeTenantReloader.reloadChannels", () => {
  it("tenant не найден → log + ранний выход", async () => {
    const logs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const reloader = makeTenantReloader(
      baseOpts({
        db: {
          select: () => ({ from: () => ({ where: async () => [] }) }),
        } as unknown as Db,
        log: (msg, ctx) => logs.push({ msg, ctx }),
      }),
    );
    await reloader.reloadChannels(1);
    expect(logs.some((l) => l.msg.includes("tenant not found"))).toBe(true);
  });

  it("reload с web+userbot реестрами → дергает обе ветки (lines 114, 117)", async () => {
    const calls: string[] = [];
    const reloader = makeTenantReloader(
      baseOpts({
        registry: {
          reloadTenant: async () => {
            calls.push("main");
          },
          getTelegramBotsByTenant: () => [{}, {}],
        } as unknown as TenantReloaderOpts["registry"],
        webRegistry: {
          reloadTenant: async () => {
            calls.push("web");
          },
          byTenant: () => ({}),
        } as unknown as TenantReloaderOpts["webRegistry"],
        userbotRegistry: {
          reloadTenant: async () => {
            calls.push("userbot");
          },
          byTenant: () => [{}],
        } as unknown as TenantReloaderOpts["userbotRegistry"],
      }),
    );
    await reloader.reloadChannels(42);
    expect(calls).toEqual(["main", "web", "userbot"]);
  });

  it("reload без опциональных реестров → только main", async () => {
    const calls: string[] = [];
    const reloader = makeTenantReloader(
      baseOpts({
        registry: {
          reloadTenant: async () => {
            calls.push("main");
          },
          getTelegramBotsByTenant: () => [],
        } as unknown as TenantReloaderOpts["registry"],
      }),
    );
    await reloader.reloadChannels(42);
    expect(calls).toEqual(["main"]);
  });
});
