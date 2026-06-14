import {
  type Db,
	EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
  mergeBotSettings,
  parseBotSettings,
  PROVIDER_RELAY_FEATURE_KEY,
  serializeBotSettings,
  TenantFeatureFlagRepo,
  withTenant,
} from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

/**
 * Per-tenant tenant management endpoints — pause/resume bot, etc.
 *
 * Endpoints:
 *   GET  /api/admin/tenant                         — tenant info
 *   PUT  /api/admin/tenant/status                  — { paused: boolean }
 *   GET  /api/admin/tenant/features                — rollout flags
 *   PUT  /api/admin/tenant/features/provider-relay — { enabled: boolean }
 *   PUT  /api/admin/tenant/features/exchange-response-guard — { enabled: boolean }
 *
 * Pause flow:
 *   tenant.status='suspended' → ChannelRegistry.loadFromDb filter exclude'ит
 *   все channels этого tenant'а → webhook handler возвращает 404 (no active
 *   channel), inbound сообщения отбрасываются. Admin auth по-прежнему
 *   работает (auth не проверяет tenant.status), tenant может un-pause.
 *
 * NB: deleted статус ЗАЩИЩЁН от этого endpoint'а — только хардкорный
 * superadmin / drizzle migration может выставить.
 */
export interface AdminTenantRoutesOpts {
  db: Db;
  /**
   * Hot-reload hook — после status change нужно reloadChannels (registry
   * фильтрует по tenants.status='active', существующие entries надо
   * evict/restore).
   */
  onStatusChange?: (tenantId: number) => Promise<void>;
}

export function makeAdminTenantRoutes(opts: AdminTenantRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/tenant
   * Returns: { id, slug, plan, status, llmBillingMode, createdAt }
   */
  app.get("/api/admin/tenant", async (c) => {
    const tenantId = c.var.tenantId;
    const row = await withTenant(opts.db, tenantId, async (tx) => {
      const [r] = await tx
        .select({
          id: tenants.id,
          slug: tenants.slug,
          plan: tenants.plan,
          status: tenants.status,
          llmBillingMode: tenants.llmBillingMode,
          replyHistoryLimit: tenants.replyHistoryLimit,
          replyDelaySeconds: tenants.replyDelaySeconds,
          botSettingsJson: tenants.botSettingsJson,
          createdAt: tenants.createdAt,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      return r ?? null;
    });
    if (!row) return c.json({ error: "tenant not found" }, 404);
    const { botSettingsJson, ...rest } = row;
    return c.json({ tenant: { ...rest, botSettings: parseBotSettings(botSettingsJson) } });
  });

  /**
   * PUT /api/admin/tenant/bot-settings
   * Body: частичный patch настроек поведения бота (эпик #623). Мёрджится поверх
   * текущих и нормализуется (parseBotSettings). Возвращает нормализованный объект.
   */
  app.put("/api/admin/tenant/bot-settings", async (c) => {
    const tenantId = c.var.tenantId;
    let patch: Record<string, unknown>;
    try {
      const body = (await c.req.json()) as unknown;
      patch = body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const nowEpoch = Math.floor(Date.now() / 1000);
    const merged = await withTenant(opts.db, tenantId, async (tx) => {
      const [r] = await tx
        .select({ botSettingsJson: tenants.botSettingsJson })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      const next = mergeBotSettings(parseBotSettings(r?.botSettingsJson ?? null), patch);
      await tx
        .update(tenants)
        .set({ botSettingsJson: serializeBotSettings(next), updatedAt: nowEpoch })
        .where(eq(tenants.id, tenantId));
      return next;
    });
    return c.json({ ok: true, botSettings: merged });
  });

  /**
   * PUT /api/admin/tenant/reply-history-limit
   * Body: { limit: number | null } — окно истории диалога (сообщений) в LLM-контексте.
   * null → дефолт стратегии (20). Допустимый диапазон 2..100.
   */
  app.put("/api/admin/tenant/reply-history-limit", async (c) => {
    const tenantId = c.var.tenantId;
    let body: { limit?: unknown };
    try {
      body = (await c.req.json()) as { limit?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    let limit: number | null;
    if (body.limit === null || body.limit === undefined || body.limit === "") {
      limit = null;
    } else {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 2 || n > 100) {
        return c.json({ error: "limit must be an integer 2..100 or null" }, 400);
      }
      limit = n;
    }
    const nowEpoch = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({ replyHistoryLimit: limit, updatedAt: nowEpoch })
        .where(eq(tenants.id, tenantId));
    });
    return c.json({ ok: true, replyHistoryLimit: limit });
  });

  /**
   * PUT /api/admin/tenant/reply-delay-seconds
   * Body: { seconds: number | null } — пауза перед ответом бота (debounce).
   * null/0 → выключено (отвечает сразу). Допустимый диапазон 0..120.
   */
  app.put("/api/admin/tenant/reply-delay-seconds", async (c) => {
    const tenantId = c.var.tenantId;
    let body: { seconds?: unknown };
    try {
      body = (await c.req.json()) as { seconds?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    let seconds: number | null;
    if (body.seconds === null || body.seconds === undefined || body.seconds === "") {
      seconds = null;
    } else {
      const n = Number(body.seconds);
      if (!Number.isInteger(n) || n < 0 || n > 120) {
        return c.json({ error: "seconds must be an integer 0..120 or null" }, 400);
      }
      seconds = n;
    }
    const nowEpoch = Math.floor(Date.now() / 1000);
    await withTenant(opts.db, tenantId, async (tx) => {
      await tx
        .update(tenants)
        .set({ replyDelaySeconds: seconds, updatedAt: nowEpoch })
        .where(eq(tenants.id, tenantId));
    });
    return c.json({ ok: true, replyDelaySeconds: seconds });
  });

  /**
   * PUT /api/admin/tenant/status
   * Body: { paused: boolean }
   *
   * paused=true → status='suspended' (channels go offline)
   * paused=false → status='active' (channels resume)
   *
   * 409 если tenant.status='deleted' (cannot un-delete через UI).
   */
  app.put("/api/admin/tenant/status", async (c) => {
    const tenantId = c.var.tenantId;
    let body: { paused?: unknown };
    try {
      body = (await c.req.json()) as { paused?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.paused !== "boolean") {
      return c.json({ error: "paused (boolean) required" }, 400);
    }
    const newStatus = body.paused ? "suspended" : "active";
    const nowEpoch = Math.floor(Date.now() / 1000);

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (!existing) return { kind: "not_found" } as const;
      if (existing.status === "deleted") {
        return { kind: "deleted" } as const;
      }
      if (existing.status === newStatus) {
        return { kind: "noop", status: newStatus } as const;
      }
      await tx
        .update(tenants)
        .set({ status: newStatus, updatedAt: nowEpoch })
        .where(eq(tenants.id, tenantId));
      return { kind: "changed", from: existing.status, to: newStatus } as const;
    });

    if (result.kind === "not_found") {
      return c.json({ error: "tenant not found" }, 404);
    }
    if (result.kind === "deleted") {
      return c.json({ error: "tenant is deleted — cannot toggle status" }, 409);
    }

    if (result.kind === "changed") {
      await withTenant(opts.db, tenantId, async (tx) => {
        await recordAudit(tx as Db, {
          tenantId,
          adminId: c.var.adminId,
          action: body.paused ? "tenant.pause" : "tenant.resume",
          targetKind: "tenant",
          targetId: tenantId,
          details: { from: result.from, to: result.to },
        });
      });

      // Hot-reload channels: ChannelRegistry фильтрует по tenants.status,
      // existing entries должны быть evicted на pause.
      if (opts.onStatusChange) {
        try {
          await opts.onStatusChange(tenantId);
        } catch (err) {
          return c.json({
            ok: true,
            status: newStatus,
            reloadError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return c.json({ ok: true, status: newStatus });
  });

  app.get("/api/admin/tenant/features", async (c) => {
    const tenantId = c.var.tenantId;
    const features = await withTenant(opts.db, tenantId, async (tx) => {
      const flags = new TenantFeatureFlagRepo({ db: tx, tenantId });
      return {
        providerRelay: await flags.isEnabled(PROVIDER_RELAY_FEATURE_KEY),
				exchangeResponseGuard: await flags.isEnabledOrDefault(
					EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
					true,
				),
      };
    });

    return c.json({ features });
  });

  app.put("/api/admin/tenant/features/provider-relay", async (c) => {
    const tenantId = c.var.tenantId;
    let body: { enabled?: unknown };
    try {
      body = (await c.req.json()) as { enabled?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) required" }, 400);
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const row = await withTenant(opts.db, tenantId, async (tx) => {
      return new TenantFeatureFlagRepo({ db: tx, tenantId }).setEnabled({
        featureKey: PROVIDER_RELAY_FEATURE_KEY,
        enabled: body.enabled as boolean,
        nowEpoch,
        metadata: { updatedByAdminId: c.var.adminId },
      });
    });

    await withTenant(opts.db, tenantId, async (tx) => {
      await recordAudit(tx as Db, {
        tenantId,
        adminId: c.var.adminId,
        action: "tenant_feature.update",
        targetKind: "tenant_feature",
        targetId: PROVIDER_RELAY_FEATURE_KEY,
        details: {
          feature: PROVIDER_RELAY_FEATURE_KEY,
          enabled: row.enabled,
        },
      });
    });

    return c.json({
      ok: true,
      feature: "providerRelay",
      enabled: row.enabled,
    });
  });

	app.put("/api/admin/tenant/features/exchange-response-guard", async (c) => {
		const tenantId = c.var.tenantId;
		let body: { enabled?: unknown };
		try {
			body = (await c.req.json()) as { enabled?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.enabled !== "boolean") {
			return c.json({ error: "enabled (boolean) required" }, 400);
		}

		const nowEpoch = Math.floor(Date.now() / 1000);
		const row = await withTenant(opts.db, tenantId, async (tx) => {
			return new TenantFeatureFlagRepo({ db: tx, tenantId }).setEnabled({
				featureKey: EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
				enabled: body.enabled as boolean,
				nowEpoch,
				metadata: { updatedByAdminId: c.var.adminId },
			});
		});

		await withTenant(opts.db, tenantId, async (tx) => {
			await recordAudit(tx as Db, {
				tenantId,
				adminId: c.var.adminId,
				action: "tenant_feature.update",
				targetKind: "tenant_feature",
				targetId: EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
				details: {
					feature: EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
					enabled: row.enabled,
				},
			});
		});

		return c.json({
			ok: true,
			feature: "exchangeResponseGuard",
			enabled: row.enabled,
		});
	});

  return app;
}
