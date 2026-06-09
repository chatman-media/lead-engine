import {
  type Db,
  type NotificationService,
  withTenant,
} from "@chatman-media/conversation-engine";
import {
  adminNotifications,
  admins,
  channelIdentities,
  channels,
  conversations,
  leads,
  messages,
  operatorSettings,
  outboundQueue,
  stageDefinitions,
} from "@chatman-media/storage";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

type OperatorNotifier = Pick<NotificationService, "sendDirectMessage">;

type OperatorOutreachTarget = "all" | "role" | "admins";
type OperatorOutreachRole = "manager" | "superadmin";
type OperatorOutreachChannel = "in_app" | "telegram";
type OperatorOutreachPriority = "normal" | "important" | "critical";

const OPERATOR_TARGETS = new Set<OperatorOutreachTarget>(["all", "role", "admins"]);
const OPERATOR_ROLES = new Set<OperatorOutreachRole>(["manager", "superadmin"]);
const OPERATOR_CHANNELS = new Set<OperatorOutreachChannel>(["in_app", "telegram"]);
const OPERATOR_PRIORITIES = new Set<OperatorOutreachPriority>([
  "normal",
  "important",
  "critical",
]);

function isOperatorTarget(value: unknown): value is OperatorOutreachTarget {
  return typeof value === "string" && OPERATOR_TARGETS.has(value as OperatorOutreachTarget);
}

function isOperatorRole(value: unknown): value is OperatorOutreachRole {
  return typeof value === "string" && OPERATOR_ROLES.has(value as OperatorOutreachRole);
}

function isOperatorPriority(value: unknown): value is OperatorOutreachPriority {
  return typeof value === "string" && OPERATOR_PRIORITIES.has(value as OperatorOutreachPriority);
}

function normalizeOperatorChannels(value: unknown): OperatorOutreachChannel[] {
  if (!Array.isArray(value)) return ["in_app", "telegram"];
  const channels = value.filter(
    (item): item is OperatorOutreachChannel =>
      typeof item === "string" && OPERATOR_CHANNELS.has(item as OperatorOutreachChannel),
  );
  return Array.from(new Set(channels));
}

function operatorSeverity(priority: OperatorOutreachPriority): "critical" | "important" | "info" {
  if (priority === "critical") return "critical";
  if (priority === "important") return "important";
  return "info";
}

function operatorTitle(priority: OperatorOutreachPriority): string {
  if (priority === "critical") return "Критичное сообщение руководителя";
  if (priority === "important") return "Важное сообщение руководителя";
  return "Сообщение руководителя";
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatOperatorTelegramText(title: string, body: string): string {
  return `<b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(body)}`;
}

/**
 * Исходящие кампании — отправить первое (или повторное) сообщение batch лидов.
 *
 * POST /api/admin/outreach
 *   Body: { text, leadIds?, stageSlug? }
 *   Returns: { enqueued, skipped }
 *
 * Алгоритм на каждого лида:
 *   1. Найти contact_id лида (leads.user_id)
 *   2. Найти первую активную channel_identity этого contact'а
 *   3. Найти или создать conversation (source из channel.kind)
 *   4. Вставить message (role='human') и enqueue outbound_queue
 *
 * Лиды без channel identity (ещё не писали в бот) — skipped.
 */
export function makeAdminOutreachRoutes(opts: {
  db: Db;
  notificationService?: OperatorNotifier | null;
}): Hono {
  const app = new Hono();

  app.post("/api/admin/outreach", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    let body: { text?: unknown; leadIds?: unknown; stageSlug?: unknown; scheduledAt?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);

    const nowEpochOuter = Math.floor(Date.now() / 1000);
    const scheduledAtRaw = typeof body.scheduledAt === "number" ? body.scheduledAt : null;
    const scheduledAt =
      scheduledAtRaw !== null && scheduledAtRaw > nowEpochOuter
        ? scheduledAtRaw
        : null;

    const hasLeadIds = Array.isArray(body.leadIds) && body.leadIds.length > 0;
    const hasStageSlug = typeof body.stageSlug === "string" && body.stageSlug.trim().length > 0;
    if (!hasLeadIds && !hasStageSlug) {
      return c.json({ error: "leadIds or stageSlug required" }, 400);
    }

    const result = await withTenant(opts.db, tenantId, async (tx) => {
      const nowEpoch = Math.floor(Date.now() / 1000);
      const sendAt = scheduledAt ?? nowEpoch;

      // 1. Resolve target lead rows → { id, userId }
      let targetLeads: Array<{ id: number; userId: number }>;

      if (hasLeadIds) {
        const ids = (body.leadIds as unknown[])
          .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
        if (ids.length === 0) return { enqueued: 0, skipped: 0 };
        targetLeads = await tx
          .select({ id: leads.id, userId: leads.userId })
          .from(leads)
          .where(and(eq(leads.tenantId, tenantId), inArray(leads.id, ids)));
      } else {
        const slug = (body.stageSlug as string).trim();
        const [stageDef] = await tx
          .select({ id: stageDefinitions.id })
          .from(stageDefinitions)
          .where(eq(stageDefinitions.slug, slug))
          .limit(1);
        if (!stageDef) return { enqueued: 0, skipped: 0 };
        targetLeads = await tx
          .select({ id: leads.id, userId: leads.userId })
          .from(leads)
          .where(
            and(
              eq(leads.tenantId, tenantId),
              eq(leads.stageDefinitionId, stageDef.id),
            ),
          );
      }

      if (targetLeads.length === 0) return { enqueued: 0, skipped: 0 };

      let enqueued = 0;
      let skipped = 0;

      for (const lead of targetLeads) {
        // 2. Find first active channel identity for this contact.
        const [identity] = await tx
          .select({
            channelDbId: channels.id,
            channelKind: channels.kind,
            externalUserId: channelIdentities.externalUserId,
          })
          .from(channelIdentities)
          .innerJoin(channels, eq(channels.id, channelIdentities.channelId))
          .where(
            and(
              eq(channelIdentities.contactId, lead.userId),
              eq(channels.tenantId, tenantId),
              eq(channels.status, "active"),
            ),
          )
          .limit(1);

        if (!identity) {
          skipped++;
          continue;
        }

        // 3. Find or create conversation.
        const source = identity.channelKind === "telegram_userbot" ? "userbot" : "bot";

        let conversationId: number;
        const [existingConv] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, tenantId),
              eq(conversations.userId, lead.userId),
              eq(conversations.source, source),
            ),
          )
          .limit(1);

        if (existingConv) {
          conversationId = existingConv.id;
          // Touch lastMessageAt so conversation surfaces in list.
          await tx
            .update(conversations)
            .set({ lastMessageAt: nowEpoch })
            .where(eq(conversations.id, conversationId));
        } else {
          const [newConv] = await tx
            .insert(conversations)
            .values({
              tenantId,
              userId: lead.userId,
              source,
              mode: "human",
              lastMessageAt: nowEpoch,
              createdAt: nowEpoch,
            })
            .returning({ id: conversations.id });
          if (!newConv) { skipped++; continue; }
          conversationId = newConv.id;
        }

        // 4. Insert message record (role='human' — отправлено оператором).
        const [msg] = await tx
          .insert(messages)
          .values({
            tenantId,
            conversationId,
            role: "human",
            text,
            metaJson: JSON.stringify({ adminId, sentVia: "outreach", leadId: lead.id }),
            createdAt: nowEpoch,
          })
          .returning({ id: messages.id });
        if (!msg) { skipped++; continue; }

        // 5. Enqueue outbound.
        const envelope = {
          channelId: String(identity.channelDbId),
          externalUserId: identity.externalUserId,
          parts: [{ kind: "text", text }],
        };
        await tx.insert(outboundQueue).values({
          tenantId,
          channelId: identity.channelDbId,
          conversationId,
          payloadJson: JSON.stringify(envelope),
          idempotencyKey: `outreach-${msg.id}`,
          scheduledAt: sendAt,
          createdAt: nowEpoch,
        });

        enqueued++;
      }

      return { enqueued, skipped, scheduledAt: scheduledAt ?? null };
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "outreach.send",
      targetKind: "outreach",
      targetId: undefined,
      details: {
        text: text.slice(0, 100),
        ...(hasStageSlug ? { stageSlug: body.stageSlug } : {}),
        ...(hasLeadIds ? { leadCount: (body.leadIds as number[]).length } : {}),
        enqueued: result.enqueued,
        skipped: result.skipped,
      },
    });

    return c.json(result, 200);
  });

  app.post("/api/admin/outreach/operators", async (c) => {
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId as number | undefined;

    if (c.var.role !== "superadmin") {
      return c.json({ error: "superadmin_required" }, 403);
    }

    let body: {
      text?: unknown;
      target?: unknown;
      role?: unknown;
      adminIds?: unknown;
      channels?: unknown;
      priority?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return c.json({ error: "text required" }, 400);
    if (text.length > 4000) return c.json({ error: "text too long" }, 400);

    const target = isOperatorTarget(body.target) ? body.target : "all";
    const priority = isOperatorPriority(body.priority) ? body.priority : "normal";
    const selectedChannels = normalizeOperatorChannels(body.channels);
    if (selectedChannels.length === 0) return c.json({ error: "channels required" }, 400);

    const targetRole = isOperatorRole(body.role) ? body.role : null;
    if (target === "role" && !targetRole) return c.json({ error: "role required" }, 400);

    const targetAdminIds = Array.isArray(body.adminIds)
      ? Array.from(
          new Set(
            body.adminIds.filter(
              (item): item is number => typeof item === "number" && Number.isFinite(item),
            ),
          ),
        )
      : [];
    if (target === "admins" && targetAdminIds.length === 0) {
      return c.json({ error: "adminIds required" }, 400);
    }

    const targetOperators = await withTenant(opts.db, tenantId, async (tx) => {
      const filters = [eq(admins.tenantId, tenantId)];
      if (target === "role" && targetRole) filters.push(eq(admins.role, targetRole));
      if (target === "admins") filters.push(inArray(admins.id, targetAdminIds));

      return tx
        .select({
          id: admins.id,
          email: admins.email,
          role: admins.role,
          telegramChatId: operatorSettings.telegramChatId,
        })
        .from(admins)
        .leftJoin(
          operatorSettings,
          and(
            eq(operatorSettings.adminId, admins.id),
            eq(operatorSettings.tenantId, tenantId),
          ),
        )
        .where(and(...filters));
    });

    const nowEpoch = Math.floor(Date.now() / 1000);
    const channelsSet = new Set(selectedChannels);
    const title = operatorTitle(priority);
    const severity = operatorSeverity(priority);
    const telegramText = formatOperatorTelegramText(title, text);
    let inAppDelivered = 0;
    let telegramDelivered = 0;
    let telegramSkipped = 0;
    let telegramFailed = 0;

    for (const operator of targetOperators) {
      const wantsInApp = channelsSet.has("in_app");
      const wantsTelegram = channelsSet.has("telegram");
      let notificationId: number | null = null;

      const insertNotification = async () => {
        if (notificationId !== null) return notificationId;
        const [inserted] = await opts.db
          .insert(adminNotifications)
          .values({
            tenantId,
            adminId: operator.id,
            topic: "system",
            severity,
            kind: "operator_broadcast",
            title,
            body: text,
            dedupKey: `operator-outreach:${tenantId}:${operator.id}:${nowEpoch}`,
            targetChatId: operator.telegramChatId,
            createdAt: nowEpoch,
          })
          .returning({ id: adminNotifications.id });
        notificationId = inserted?.id ?? null;
        inAppDelivered++;
        return notificationId;
      };

      if (wantsInApp || (wantsTelegram && !operator.telegramChatId)) {
        await insertNotification();
      }

      if (!wantsTelegram) continue;
      if (!operator.telegramChatId) {
        telegramSkipped++;
        continue;
      }

      const sendResult = opts.notificationService
        ? await opts.notificationService.sendDirectMessage(operator.telegramChatId, telegramText)
        : { ok: false, error: "notification service unavailable" };

      if (sendResult.ok) {
        telegramDelivered++;
        if (notificationId !== null) {
          await opts.db
            .update(adminNotifications)
            .set({ deliveredAt: nowEpoch })
            .where(eq(adminNotifications.id, notificationId));
        }
      } else {
        telegramFailed++;
        if (!wantsInApp) await insertNotification();
      }
    }

    const result = {
      ok: true,
      targets: targetOperators.length,
      inAppDelivered,
      telegramDelivered,
      telegramSkipped,
      telegramFailed,
    };

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "operator_outreach.send",
      targetKind: "operator_outreach",
      details: {
        text: text.slice(0, 100),
        target,
        ...(targetRole ? { role: targetRole } : {}),
        ...(target === "admins" ? { adminIds: targetAdminIds } : {}),
        channels: selectedChannels,
        priority,
        ...result,
      },
    });

    return c.json(result, 200);
  });

  return app;
}
