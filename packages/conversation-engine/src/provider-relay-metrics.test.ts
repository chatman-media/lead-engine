import { describe, expect, it } from "bun:test";
import { normalizeMetricLabel, providerRelayTenantLabels } from "./provider-relay-metrics.ts";

describe("providerRelayTenantLabels", () => {
  it("оборачивает tenantId в { tenant } строкой", () => {
    expect(providerRelayTenantLabels(42)).toEqual({ tenant: "42" });
  });
});

describe("normalizeMetricLabel", () => {
  it("не строка → 'unknown'", () => {
    expect(normalizeMetricLabel(123)).toBe("unknown");
    expect(normalizeMetricLabel(null)).toBe("unknown");
    expect(normalizeMetricLabel(undefined)).toBe("unknown");
  });

  it("trim + lowercase + замена недопустимых символов на '_'", () => {
    expect(normalizeMetricLabel("  Hello World!  ")).toBe("hello_world_");
    expect(normalizeMetricLabel("Provider/Name")).toBe("provider_name");
  });

  it("разрешённые символы (a-z0-9_:-) сохраняются", () => {
    expect(normalizeMetricLabel("rate:guard-1_x")).toBe("rate:guard-1_x");
  });

  it("строка из одних недопустимых символов → '_' (не пустая)", () => {
    // "***" → "_", остаётся непустой → возвращается "_"
    expect(normalizeMetricLabel("***")).toBe("_");
  });

  it("пустая строка → 'unknown' (fallback после нормализации)", () => {
    expect(normalizeMetricLabel("")).toBe("unknown");
    expect(normalizeMetricLabel("   ")).toBe("unknown");
  });
});
