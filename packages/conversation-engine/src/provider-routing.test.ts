// Unit-тест ProviderRouter. DB фейкается: select-цепочки (.from().innerJoin()
// .where().limit()) и .execute(sql) отдают заранее заданные очереди результатов.
// Покрывает orchestration + маппинг rawToCandidate без Postgres.

import { describe, expect, it } from "bun:test";
import type { Db } from "./dal/types.ts";
import { ProviderRouter } from "./provider-routing.ts";

type Rows = unknown[];

function makeCtx(opts: { selectQueue?: Rows[]; executeQueue?: Rows[] }) {
  const selectQueue = [...(opts.selectQueue ?? [])];
  const executeQueue = [...(opts.executeQueue ?? [])];
  const chain = (result: Rows) => {
    const node: Record<string, unknown> = {
      from: () => node,
      innerJoin: () => node,
      where: () => node,
      limit: async () => result,
    };
    return node;
  };
  const db = {
    select: () => chain(selectQueue.shift() ?? []),
    execute: async () => executeQueue.shift() ?? [],
  } as unknown as Db;
  return { db, tenantId: 1 };
}

function rawRow(over: Record<string, unknown> = {}) {
  return {
    provider_id: 10,
    provider_name: "Acme",
    provider_status: "active",
    provider_service_id: 100,
    service_type: "delivery",
    service_name: "Express",
    service_area: "BKK",
    provider_service_area: "BKK",
    provider_profile_area: null,
    active_order_count: "3",
    commission_pct: 5.5,
    exact_area_rank: 0,
    ...over,
  };
}

describe("ProviderRouter.selectProvider", () => {
  it("пустой serviceType → no_provider_available (без DB)", async () => {
    const router = new ProviderRouter(makeCtx({}));
    const res = await router.selectProvider({ serviceType: "   " });
    expect(res).toEqual({
      ok: false,
      reason: "no_provider_available",
      details: "serviceType is empty",
    });
  });

  it("без override, кандидат найден → ok + маппинг rawToCandidate", async () => {
    const router = new ProviderRouter(makeCtx({ executeQueue: [[rawRow()]] }));
    const res = await router.selectProvider({
      serviceType: "delivery",
      serviceArea: "BKK",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.override).toBe(false);
      expect(res.candidate.providerId).toBe(10);
      expect(res.candidate.activeOrderCount).toBe(3); // Number("3")
      expect(res.candidate.commissionPct).toBe(5.5);
    }
  });

  it("без override, нет кандидата, но есть сервис в др. зоне → area_unavailable", async () => {
    const router = new ProviderRouter(
      makeCtx({
        executeQueue: [[]], // findBestCandidate пусто
        selectQueue: [[{ id: 1 }]], // hasEligibleServiceIgnoringArea → есть
      }),
    );
    const res = await router.selectProvider({
      serviceType: "delivery",
      serviceArea: "Phuket",
    });
    expect(res).toEqual({ ok: false, reason: "area_unavailable" });
  });

  it("без override, нет кандидата и нет сервиса вовсе → no_provider_available", async () => {
    const router = new ProviderRouter(makeCtx({ executeQueue: [[]], selectQueue: [[]] }));
    const res = await router.selectProvider({ serviceType: "delivery" });
    expect(res).toEqual({ ok: false, reason: "no_provider_available" });
  });

  it("override: провайдер не найден → provider_not_found", async () => {
    const router = new ProviderRouter(makeCtx({ selectQueue: [[]] }));
    const res = await router.selectProvider({
      serviceType: "delivery",
      providerIdOverride: 99,
    });
    expect(res).toEqual({ ok: false, reason: "provider_not_found" });
  });

  it("override: провайдер на паузе → provider_paused", async () => {
    const router = new ProviderRouter(makeCtx({ selectQueue: [[{ id: 99, status: "paused" }]] }));
    const res = await router.selectProvider({
      serviceType: "delivery",
      providerIdOverride: 99,
    });
    expect(res).toEqual({ ok: false, reason: "provider_paused" });
  });

  it("override: активный провайдер + кандидат → ok, override=true", async () => {
    const router = new ProviderRouter(
      makeCtx({
        selectQueue: [[{ id: 10, status: "active" }]],
        executeQueue: [[rawRow({ provider_id: 10 })]],
      }),
    );
    const res = await router.selectProvider({
      serviceType: "delivery",
      providerIdOverride: 10,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.override).toBe(true);
  });

  it("override: активный провайдер, нет кандидата, есть активный сервис → area_unavailable", async () => {
    const router = new ProviderRouter(
      makeCtx({
        selectQueue: [[{ id: 10, status: "active" }], [{ id: 1 }]],
        executeQueue: [[]],
      }),
    );
    const res = await router.selectProvider({
      serviceType: "delivery",
      serviceArea: "BKK",
      providerIdOverride: 10,
    });
    expect(res).toEqual({ ok: false, reason: "area_unavailable" });
  });

  it("override: активный провайдер, нет кандидата и нет активного сервиса → service_inactive", async () => {
    const router = new ProviderRouter(
      makeCtx({
        selectQueue: [[{ id: 10, status: "active" }], []],
        executeQueue: [[]],
      }),
    );
    const res = await router.selectProvider({
      serviceType: "delivery",
      providerIdOverride: 10,
    });
    expect(res).toEqual({ ok: false, reason: "service_inactive" });
  });
});
