import type { MiddlewareHandler } from "hono";
import { resolveTenantFromHost, type TenantHostConfig } from "../lib/tenant-host.ts";

/**
 * Hono middleware: парсит Host header и пишет в c.var.tenantSlug.
 * Используется admin-API routes — webhook'и (Telegram/Meta) остаются
 * path-based и не зависят от этого.
 *
 * Поведение:
 *   - tenant-subdomain → c.var.tenantSlug = slug, c.var.tenantKind="tenant"
 *   - apex / reserved → c.var.tenantKind="apex", slug=undefined
 *   - spoofed host (not from baseDomain) → 400 reject
 *
 * Routes которые требуют tenant обязательно проверяют c.var.tenantKind
 * или используют requireTenant ниже.
 */
declare module "hono" {
  interface ContextVariableMap {
    tenantSlug?: string;
    tenantKind?: "tenant" | "apex";
  }
}

export function makeTenantContextMiddleware(cfg: TenantHostConfig): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("Host") ?? null;
    const resolved = resolveTenantFromHost(host, cfg);
    if (resolved === null) {
      return c.json({ error: "invalid host", host }, 400);
    }
    c.set("tenantKind", resolved.kind);
    if (resolved.kind === "tenant") {
      c.set("tenantSlug", resolved.slug);
    }
    await next();
  };
}

/**
 * Inline-guard для конкретных routes: бросает 404 если tenant не зарезолвлен.
 * Использовать так:
 *   app.get("/admin/leads", requireTenant, async (c) => {
 *     const slug = c.var.tenantSlug!;  // safe: requireTenant прошёл
 *     ...
 *   });
 */
export const requireTenant: MiddlewareHandler = async (c, next) => {
  if (c.var.tenantKind !== "tenant" || !c.var.tenantSlug) {
    return c.json({ error: "tenant subdomain required" }, 404);
  }
  await next();
};
