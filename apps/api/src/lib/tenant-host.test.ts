import { describe, expect, it } from "bun:test";
import { resolveTenantFromHost, resolveTenantFromPath } from "./tenant-host.ts";

const cfg = { baseDomain: "leadengine.app" };

describe("resolveTenantFromHost", () => {
  it("subdomain → tenant", () => {
    expect(resolveTenantFromHost("studio-alpha.leadengine.app", cfg)).toEqual({
      kind: "tenant",
      slug: "studio-alpha",
    });
  });

  it("apex домен → kind=apex", () => {
    expect(resolveTenantFromHost("leadengine.app", cfg)).toEqual({ kind: "apex" });
  });

  it("reserved subdomain → kind=apex (default reserved list)", () => {
    expect(resolveTenantFromHost("admin.leadengine.app", cfg)).toEqual({ kind: "apex" });
    expect(resolveTenantFromHost("www.leadengine.app", cfg)).toEqual({ kind: "apex" });
    expect(resolveTenantFromHost("api.leadengine.app", cfg)).toEqual({ kind: "apex" });
  });

  it("custom reserved list overrides default", () => {
    const res = resolveTenantFromHost("admin.leadengine.app", {
      ...cfg,
      reservedSubdomains: ["www"],
    });
    expect(res).toEqual({ kind: "tenant", slug: "admin" });
  });

  it("host НЕ из baseDomain → null (spoof rejection)", () => {
    expect(resolveTenantFromHost("studio.evil.com", cfg)).toBe(null);
    expect(resolveTenantFromHost("leadengine.app.evil.com", cfg)).toBe(null);
  });

  it("nested subdomain → null (multi-level rejection)", () => {
    // Защита от 'admin.evil.leadengine.app' — два сегмента в subdomain'е,
    // мы не пытаемся угадать какой из них tenant.
    expect(resolveTenantFromHost("preview.studio.leadengine.app", cfg)).toBe(null);
  });

  it("port в Host header — strip", () => {
    expect(resolveTenantFromHost("studio-alpha.leadengine.app:3000", cfg)).toEqual({
      kind: "tenant",
      slug: "studio-alpha",
    });
  });

  it("case-insensitive", () => {
    expect(resolveTenantFromHost("Studio-Alpha.LeadEngine.App", cfg)).toEqual({
      kind: "tenant",
      slug: "studio-alpha",
    });
  });

  it("invalid slug pattern (uppercase, спецсимволы) → null", () => {
    expect(resolveTenantFromHost("--evil.leadengine.app", cfg)).toBe(null);
    expect(resolveTenantFromHost("1starts-with-digit.leadengine.app", cfg)).toBe(null);
  });

  it("пустой/null host → null", () => {
    expect(resolveTenantFromHost(null, cfg)).toBe(null);
    expect(resolveTenantFromHost(undefined, cfg)).toBe(null);
    expect(resolveTenantFromHost("", cfg)).toBe(null);
  });
});

describe("resolveTenantFromPath", () => {
  it("/t/<slug>/<rest> → split", () => {
    expect(resolveTenantFromPath("/t/studio-alpha/leads/42")).toEqual({
      slug: "studio-alpha",
      rest: "/leads/42",
    });
  });

  it("/t/<slug> без trailing slash → rest='/'", () => {
    expect(resolveTenantFromPath("/t/studio-alpha")).toEqual({
      slug: "studio-alpha",
      rest: "/",
    });
  });

  it("обычный path → null", () => {
    expect(resolveTenantFromPath("/admin/dashboard")).toBe(null);
    expect(resolveTenantFromPath("/webhook/telegram/legacy")).toBe(null);
  });

  it("invalid slug в pathе → null", () => {
    expect(resolveTenantFromPath("/t/UPPER/x")).toBe(null);
    expect(resolveTenantFromPath("/t//missing")).toBe(null);
  });
});
