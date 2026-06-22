import {
  type InformerPrefs,
  type NotificationService,
  type NotificationsRepo,
  type OpsAlertRouter,
} from "@chatman-media/conversation-engine";
import { Hono } from "hono";

const INFORMER_LEVELS = ["silent", "critical", "important", "all"];
const INFORMER_DIGESTS = ["off", "daily", "shift"];
const INFORMER_TOPIC_KEYS = ["leads", "escalation", "orders", "system"];

export function makeAdminNotificationsRoutes(opts: {
  repo: NotificationsRepo;
  botUsername?: string;
  notificationService?: NotificationService;
  /** Роутер операционных алертов владельцу (#145). */
  opsRouter?: OpsAlertRouter;
  /** Настроен ли email-канал (RESEND_API_KEY) — для UI-индикатора. */
  opsEmailConfigured?: boolean;
}): Hono {
  const app = new Hono();

  // GET /api/admin/notifications/rules — список правил
  app.get("/rules", async (c) => {
    const tenantId = c.var.tenantId;
    const items = await opts.repo.listRules(tenantId);
    return c.json({ items });
  });

  // POST /api/admin/notifications/rules — создать правило
  app.post("/rules", async (c) => {
    const tenantId = c.var.tenantId;
    const body = await c.req.json();
    const rule = await opts.repo.createRule({
      tenantId,
      eventType: body.eventType,
      conditionJson: JSON.stringify(body.condition || {}),
      channelType: body.channelType || "telegram_group",
      targetId: body.targetId,
      // #651: форум-группа — opt-in флаг (по умолчанию обычный чат). Обычно
      // выставляется автоматически при /setup в форум-группе.
      targetIsForum: body.targetIsForum === true,
      priority: body.priority || "normal",
      isActive: true,
    });
    return c.json(rule, 201);
  });

  // DELETE /api/admin/notifications/rules/:id — удалить правило
  app.delete("/rules/:id", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    await opts.repo.deleteRule(tenantId, id);
    return c.json({ ok: true });
  });

  // POST /api/admin/notifications/rules/:id/test — тестовое сообщение
  app.post("/rules/:id/test", async (c) => {
    const tenantId = c.var.tenantId;
    const id = Number(c.req.param("id"));
    const rules = await opts.repo.listRules(tenantId);
    const rule = rules.find((r) => r.id === id);
    if (!rule) return c.json({ ok: false, error: "Правило не найдено" }, 404);
    if (!opts.notificationService) return c.json({ ok: false, error: "Сервис уведомлений не настроен" });
    const result = await opts.notificationService.sendTestMessage(rule.targetId);
    return c.json(result);
  });

  // GET /api/admin/notifications/settings — личные настройки
  app.get("/settings", async (c) => {
    const adminId = c.var.adminId;
    const settings = await opts.repo.findOperatorSettings(adminId);
    return c.json({
      ...(settings || { adminId, telegramChatId: null, notifyOnAssignedOnly: true }),
      botUsername: opts.botUsername || null,
    });
  });

  // PUT /api/admin/notifications/settings — частичное обновление личных настроек
  app.put("/settings", async (c) => {
    const adminId = c.var.adminId;
    const tenantId = c.var.tenantId;
    const body = await c.req.json();
    await opts.repo.partialUpdateSettings(adminId, tenantId, {
      ...("telegramChatId" in body ? { telegramChatId: body.telegramChatId } : {}),
      ...("notifyOnAssignedOnly" in body ? { notifyOnAssignedOnly: body.notifyOnAssignedOnly } : {}),
    });
    return c.json({ ok: true });
  });

  // POST /api/admin/notifications/settings/link — создать токен привязки
  app.post("/settings/link", async (c) => {
    const adminId = c.var.adminId;
    const tenantId = c.var.tenantId;
    const token = await opts.repo.generateLinkToken(adminId, tenantId);
    return c.json({ token });
  });

  // POST /api/admin/notifications/group-link — токен для привязки группы через бота
  app.post("/group-link", async (c) => {
    const adminId = c.var.adminId;
    const tenantId = c.var.tenantId;
    const body = await c.req.json().catch(() => ({}));
    const eventType: string = body.eventType || "operator_all";
    const token = await opts.repo.generateGroupLinkToken(tenantId, adminId, eventType);
    return c.json({ token });
  });

  // ---- Информер владельца (уровни + дайджест + лента) ----

  // GET /api/admin/notifications/informer/feed — последние уведомления (лента/scrollback).
  app.get("/informer/feed", async (c) => {
    const adminId = c.var.adminId;
    const tenantId = c.var.tenantId;
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
    const items = await opts.repo.listRecentNotifications(tenantId, adminId, limit);
    return c.json({ items });
  });

  // POST /api/admin/notifications/informer/read — отметить in-app уведомления прочитанными.
  app.post("/informer/read", async (c) => {
    const adminId = c.var.adminId;
    const tenantId = c.var.tenantId;
    await opts.repo.markNotificationsRead(tenantId, adminId, Math.floor(Date.now() / 1000));
    return c.json({ ok: true });
  });

  // PUT /api/admin/notifications/informer — настройки информера (порог/темы/дайджест/мут).
  app.put("/informer", async (c) => {
    const adminId = c.var.adminId;
    const tenantId = c.var.tenantId;
    const body = await c.req.json().catch(() => ({}));
    const prefs: InformerPrefs = {};
    if (typeof body.informerLevel === "string" && INFORMER_LEVELS.includes(body.informerLevel)) {
      prefs.informerLevel = body.informerLevel;
    }
    if (typeof body.informerDigest === "string" && INFORMER_DIGESTS.includes(body.informerDigest)) {
      prefs.informerDigest = body.informerDigest;
    }
    if (
      Number.isInteger(body.informerDigestHour) &&
      body.informerDigestHour >= 0 &&
      body.informerDigestHour <= 23
    ) {
      prefs.informerDigestHour = body.informerDigestHour;
    }
    if (typeof body.informerTz === "string" && body.informerTz.length > 0 && body.informerTz.length <= 64) {
      prefs.informerTz = body.informerTz;
    }
    if ("informerMutedUntil" in body) {
      const v = body.informerMutedUntil;
      prefs.informerMutedUntil = v === null || !Number.isFinite(Number(v)) ? null : Number(v);
    }
    if (body.informerTopics && typeof body.informerTopics === "object") {
      const map: Record<string, boolean> = {};
      for (const t of INFORMER_TOPIC_KEYS) map[t] = body.informerTopics[t] !== false;
      prefs.informerTopics = JSON.stringify(map);
    }
    for (const key of ["informerQuietFrom", "informerQuietTo"] as const) {
      if (key in body) {
        const v = body[key];
        prefs[key] =
          v === null || !Number.isInteger(Number(v)) ? null : Math.min(Math.max(Number(v), 0), 23);
      }
    }
    await opts.repo.updateInformerPrefs(adminId, prefs, tenantId);
    return c.json({ ok: true });
  });

  // POST /api/admin/notifications/settings/test — отправить себе тест-уведомление
  app.post("/settings/test", async (c) => {
    const adminId = c.var.adminId;
    const settings = await opts.repo.findOperatorSettings(adminId);
    if (!settings?.telegramChatId) {
      return c.json({ ok: false, error: "Telegram не подключён" }, 400);
    }
    if (!opts.notificationService) {
      return c.json({ ok: false, error: "Сервис уведомлений не настроен" }, 400);
    }
    const result = await opts.notificationService.sendTestMessage(settings.telegramChatId);
    return c.json(result);
  });

  // ---- Операционные алерты (#145) ----

  // GET /api/admin/notifications/ops-status — готовность доставки владельцу.
  app.get("/ops-status", async (c) => {
    const tenantId = c.var.tenantId;
    // Операционные алерты доставляются ВЛАДЕЛЬЦУ (superadmin), а не любому
    // оператору. Статус привязки Telegram считаем по его личному чату — иначе
    // индикатор «Доставка настроена» зеленеет, пока владелец не получает алерты.
    const owner = await opts.repo.resolveOwnerSettings(tenantId);
    const telegramLinked = !!owner?.settings?.telegramChatId;
    return c.json({
      enabled: !!opts.opsRouter,
      botConfigured: !!opts.botUsername,
      telegramLinked,
      emailConfigured: !!opts.opsEmailConfigured,
    });
  });

  // POST /api/admin/notifications/ops-test — тестовый операционный алерт владельцу.
  app.post("/ops-test", async (c) => {
    const tenantId = c.var.tenantId;
    if (!opts.opsRouter) return c.json({ ok: false, error: "Ops-роутер не настроен" });
    await opts.opsRouter.emit({
      tenantId,
      kind: "rate_feed_stale",
      severity: "warning",
      title: "Тестовый операционный алерт",
      detail: "Если вы это видите — доставка алертов владельцу работает (Telegram/email).",
      dedupKey: `ops-test:${c.var.adminId}:${Math.floor(Date.now() / 1000)}`,
    });
    return c.json({ ok: true });
  });

  // ---- Templates ----

  // GET /api/admin/notifications/templates — список шаблонов
  app.get("/templates", async (c) => {
    const tenantId = c.var.tenantId;
    const items = await opts.repo.listTemplates(tenantId);
    return c.json({ items });
  });

  // PUT /api/admin/notifications/templates/:slug — создать или обновить шаблон
  app.put("/templates/:slug", async (c) => {
    const tenantId = c.var.tenantId;
    const slug = c.req.param("slug");
    const { body } = await c.req.json();
    if (!body) return c.json({ error: "body required" }, 400);

    await opts.repo.upsertTemplate({
      tenantId,
      slug,
      body,
    });
    return c.json({ ok: true });
  });

  // DELETE /api/admin/notifications/templates/:slug — удалить шаблон
  app.delete("/templates/:slug", async (c) => {
    const tenantId = c.var.tenantId;
    const slug = c.req.param("slug");
    await opts.repo.deleteTemplate(tenantId, slug);
    return c.json({ ok: true });
  });

  return app;
}
