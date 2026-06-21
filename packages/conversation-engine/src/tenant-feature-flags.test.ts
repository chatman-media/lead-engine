// Unit-тест TenantFeatureFlagRepo. DB фейкается: select-цепочка .from().where()
// .limit() и insert-цепочка .values().onConflictDoUpdate().returning() отдают
// заданные результаты. Покрывает isEnabled/isEnabledOrDefault/setEnabled.

import { describe, expect, it } from "bun:test";
import type { RepoCtx } from "./dal/types.ts";
import {
  EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
  PROVIDER_RELAY_FEATURE_KEY,
  TenantFeatureFlagRepo,
} from "./tenant-feature-flags.ts";

function selectCtx(rows: unknown[]): RepoCtx {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    limit: async () => rows,
  };
  return {
    db: { select: () => node } as never,
    tenantId: 1,
  };
}

function insertCtx(returnedRow: unknown, captured: Record<string, unknown>): RepoCtx {
  return {
    db: {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          captured.values = row;
          return {
            onConflictDoUpdate: (cfg: Record<string, unknown>) => {
              captured.conflict = cfg;
              return { returning: async () => [returnedRow] };
            },
          };
        },
      }),
    } as never,
    tenantId: 1,
  };
}

describe("TenantFeatureFlagRepo.isEnabled / isEnabledOrDefault", () => {
  it("строки нет → false (дефолт isEnabled)", async () => {
    const repo = new TenantFeatureFlagRepo(selectCtx([]));
    expect(await repo.isEnabled(PROVIDER_RELAY_FEATURE_KEY)).toBe(false);
  });

  it("строка enabled=true → true", async () => {
    const repo = new TenantFeatureFlagRepo(selectCtx([{ enabled: true }]));
    expect(await repo.isEnabled(EXCHANGE_RESPONSE_GUARD_FEATURE_KEY)).toBe(true);
  });

  it("isEnabledOrDefault: строки нет → возвращает переданный дефолт", async () => {
    const repo = new TenantFeatureFlagRepo(selectCtx([]));
    expect(await repo.isEnabledOrDefault("custom_key", true)).toBe(true);
  });

  it("isEnabledOrDefault: строка enabled=false перебивает дефолт=true", async () => {
    const repo = new TenantFeatureFlagRepo(selectCtx([{ enabled: false }]));
    expect(await repo.isEnabledOrDefault("custom_key", true)).toBe(false);
  });
});

describe("TenantFeatureFlagRepo.setEnabled", () => {
  it("апсертит флаг и возвращает строку (с metadata)", async () => {
    const captured: Record<string, unknown> = {};
    const row = {
      id: 1,
      tenantId: 1,
      featureKey: "provider_relay",
      enabled: true,
      metadataJson: '{"x":1}',
      createdAt: 100,
      updatedAt: 100,
    };
    const repo = new TenantFeatureFlagRepo(insertCtx(row, captured));
    const out = await repo.setEnabled({
      featureKey: PROVIDER_RELAY_FEATURE_KEY,
      enabled: true,
      nowEpoch: 100,
      metadata: { x: 1 },
    });
    expect(out).toEqual(row);
    const values = captured.values as Record<string, unknown>;
    expect(values.metadataJson).toBe('{"x":1}');
    expect(values.enabled).toBe(true);
  });

  it("апсертит без metadata (ветка без metadataJson)", async () => {
    const captured: Record<string, unknown> = {};
    const row = {
      id: 2,
      tenantId: 1,
      featureKey: "exchange_response_guard",
      enabled: false,
      metadataJson: "{}",
      createdAt: 200,
      updatedAt: 200,
    };
    const repo = new TenantFeatureFlagRepo(insertCtx(row, captured));
    const out = await repo.setEnabled({
      featureKey: EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
      enabled: false,
      nowEpoch: 200,
    });
    expect(out.id).toBe(2);
    const values = captured.values as Record<string, unknown>;
    expect("metadataJson" in values).toBe(false);
  });

  it("insert вернул пусто → бросает", async () => {
    const captured: Record<string, unknown> = {};
    const repo = new TenantFeatureFlagRepo(insertCtx(undefined, captured));
    await expect(
      repo.setEnabled({
        featureKey: PROVIDER_RELAY_FEATURE_KEY,
        enabled: true,
        nowEpoch: 1,
      }),
    ).rejects.toThrow(/returned no row/);
  });
});
