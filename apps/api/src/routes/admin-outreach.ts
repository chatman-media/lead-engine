import { type Db, withTenant } from "@chatman-media/conversation-engine";
import {
  channelIdentities,
  channels,
  conversations,
  leads,
  messages,
  outboundQueue,
  stageDefinitions,
} from "@chatman-media/storage";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";

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
export function makeAdminOutreachRoutes(opts: { db: Db }): Hono {
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
        const source = identity.channelKind === "telegram_userbot" ? "userbot"
          : identity.channelKind === "whatsapp" ? "whatsapp"
          : identity.channelKind === "web" ? "web"
          : "bot";

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

  return app;
}
