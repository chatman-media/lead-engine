import { type NotificationService, type NotificationsRepo } from "@chatman-media/conversation-engine";
import { Hono } from "hono";

export function makeAdminNotificationsRoutes(opts: {
  repo: NotificationsRepo;
  botUsername?: string;
  notificationService?: NotificationService;
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
