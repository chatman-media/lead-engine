import { type Db, withTenant } from "@chatman-media/conversation-engine";
import { adminInvites, admins } from "@chatman-media/storage";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { recordAudit } from "../lib/audit.ts";
import { type Mailer, inviteEmailHtml } from "../lib/mailer.ts";
import { canAddAdmin } from "../lib/quota.ts";

/**
 * Multi-admin management per tenant (Q3'26 M4). Только superadmin role
 * может приглашать новых admin'ов / revoke invite'ы. Manager role видит
 * GET list для UX, но не может писать.
 *
 * Token-link flow (без email-infrastructure):
 *   1. POST /api/admin/admins/invite { email, role } → возвращает opaque
 *      token + share-url (`<PUBLIC_URL>/accept-invite?token=...`).
 *   2. Superadmin шарит share-url out-of-band (TG / WhatsApp / SMS / email
 *      руками — пока без built-in delivery).
 *   3. Приглашённый открывает share-url → UI /accept-invite → POST
 *      /api/auth/accept-invite { token, password } → создаёт admin row +
 *      session token. См. auth.ts.
 *
 * Email-доставка приглашений — Phase 3+ (нужна SES/Resend/SendGrid setup).
 *
 * Endpoints:
 *   POST   /api/admin/admins/invite   — { email, role } → { token, url, ... }
 *   GET    /api/admin/admins/invites  — list pending + accepted invites
 *   DELETE /api/admin/admins/invites/:id — revoke pending invite
 *   GET    /api/admin/admins          — list admin'ов tenant'а
 */
export interface AdminAdminsRoutesOpts {
  db: Db;
  /**
   * Publicly-reachable URL для share-link'а (`<publicUrl>/accept-invite?token=...`).
   * Если пуст — endpoint вернёт только token без url, UI сам build'ит.
   */
  publicUrl?: string;
  /** Срок жизни invite token в секундах. Default 7 days. */
  inviteExpiresSec?: number;
  /** Опциональный mailer — если задан, invite-email отправляется автоматически. */
  mailer?: Mailer;
}

interface InviteBody {
  email: unknown;
  role?: unknown;
}

const DEFAULT_INVITE_EXPIRES_SEC = 7 * 24 * 60 * 60;

function genToken(): string {
  // 32 байта random → 64 hex chars. Используем Bun's crypto.
  // biome-ignore lint/style/noNonNullAssertion: globalThis.crypto всегда доступен в Bun
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function makeAdminAdminsRoutes(opts: AdminAdminsRoutesOpts): Hono {
  const app = new Hono();

  /**
   * GET /api/admin/admins
   * Returns: { items: [{ id, email, role, createdAt }] }
   */
  app.get("/api/admin/admins", async (c) => {
    const tenantId = c.var.tenantId;
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          id: admins.id,
          email: admins.email,
          role: admins.role,
          createdAt: admins.createdAt,
        })
        .from(admins)
        .where(eq(admins.tenantId, tenantId))
        .orderBy(desc(admins.createdAt));
    });
    return c.json({ items: rows });
  });

  /**
   * POST /api/admin/admins/invite
   * Body: { email, role: 'manager' | 'superadmin' }
   *
   * Только superadmin может приглашать. Возвращает opaque token и
   * share-url (если publicUrl задан в opts). Token живёт 7 дней.
   *
   * Errors:
   *   400 — bad json / missing email / invalid role
   *   403 — caller не superadmin
   *   409 — email уже зарегистрирован в этом tenant как active admin
   */
  app.post("/api/admin/admins/invite", async (c) => {
    if (c.var.role !== "superadmin") {
      return c.json({ error: "only superadmin can invite" }, 403);
    }
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId;

    let body: InviteBody;
    try {
      body = (await c.req.json()) as InviteBody;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "valid email required" }, 400);
    }
    const role = body.role === "superadmin" ? "superadmin" : "manager";

    // Quota: сколько admin'ов разрешено на плане?
    const quota = await canAddAdmin({ db: opts.db, tenantId });
    if (!quota.allowed) {
      return c.json({
        error: "admins_limit_reached",
        upgradeHint: `Лимит участников команды на плане ${quota.planLabel}: ${quota.limit}. Повысьте план для продолжения.`,
        current: quota.current,
        limit: quota.limit,
      }, 402);
    }

    // Check existing admin с этим email в tenant'е.
    const [existing] = await opts.db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.tenantId, tenantId), eq(admins.email, email)));
    if (existing) {
      return c.json({ error: "admin with this email already exists" }, 409);
    }

    const token = genToken();
    const nowEpoch = Math.floor(Date.now() / 1000);
    const expiresAt = nowEpoch + (opts.inviteExpiresSec ?? DEFAULT_INVITE_EXPIRES_SEC);

    const [inserted] = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .insert(adminInvites)
        .values({
          tenantId,
          email,
          role,
          token,
          invitedByAdminId: adminId,
          expiresAt,
          createdAt: nowEpoch,
        })
        .returning({ id: adminInvites.id });
    });

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "admin_invite.create",
      targetKind: "admin_invite",
      targetId: inserted!.id,
      details: { email, role, expiresAt },
    });

    const shareUrl = opts.publicUrl
      ? `${opts.publicUrl}/accept-invite?token=${token}`
      : undefined;

    // Email-доставка — best-effort, не блокирует ответ.
    if (opts.mailer && shareUrl) {
      opts.mailer.send({
        to: email,
        subject: "Вас приглашают в lead-engine",
        html: inviteEmailHtml({ inviteUrl: shareUrl }),
      }).catch((e) => console.warn("[mailer] invite send failed:", e));
    }

    return c.json({
      ok: true,
      id: inserted!.id,
      token,
      ...(shareUrl ? { shareUrl } : {}),
      email,
      role,
      expiresAt,
    });
  });

  /**
   * GET /api/admin/admins/invites
   * Returns: { items: [{ id, email, role, status, expiresAt, usedAt, createdAt }] }
   *   status: 'pending' | 'accepted' | 'expired'
   */
  app.get("/api/admin/admins/invites", async (c) => {
    const tenantId = c.var.tenantId;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const rows = await withTenant(opts.db, tenantId, async (tx) => {
      return tx
        .select({
          id: adminInvites.id,
          email: adminInvites.email,
          role: adminInvites.role,
          expiresAt: adminInvites.expiresAt,
          usedAt: adminInvites.usedAt,
          createdAt: adminInvites.createdAt,
        })
        .from(adminInvites)
        .where(eq(adminInvites.tenantId, tenantId))
        .orderBy(desc(adminInvites.createdAt));
    });
    return c.json({
      items: rows.map((r) => ({
        ...r,
        status:
          r.usedAt !== null
            ? "accepted"
            : r.expiresAt < nowEpoch
              ? "expired"
              : "pending",
      })),
    });
  });

  /**
   * DELETE /api/admin/admins/invites/:id
   * Revoke pending invite. accepted/used invite revoke'нуть нельзя
   * (нужно явно удалить созданного admin'а через отдельную операцию).
   *
   * 404 — invite не существует / другой tenant
   * 409 — invite уже accepted (нельзя revoke'нуть прошлое)
   */
  app.delete("/api/admin/admins/invites/:id", async (c) => {
    if (c.var.role !== "superadmin") {
      return c.json({ error: "only superadmin can revoke invites" }, 403);
    }
    const tenantId = c.var.tenantId;
    const adminId = c.var.adminId;
    const idStr = c.req.param("id");
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: "invalid invite id" }, 400);
    }
    const outcome = await withTenant(opts.db, tenantId, async (tx) => {
      const [existing] = await tx
        .select({ usedAt: adminInvites.usedAt, email: adminInvites.email })
        .from(adminInvites)
        .where(
          and(eq(adminInvites.tenantId, tenantId), eq(adminInvites.id, id)),
        );
      if (!existing) return { kind: "not_found" } as const;
      if (existing.usedAt !== null) return { kind: "already_used" } as const;
      await tx
        .delete(adminInvites)
        .where(
          and(eq(adminInvites.tenantId, tenantId), eq(adminInvites.id, id)),
        );
      return { kind: "deleted", email: existing.email } as const;
    });

    if (outcome.kind === "not_found") {
      return c.json({ error: "invite not found" }, 404);
    }
    if (outcome.kind === "already_used") {
      return c.json({ error: "invite already used" }, 409);
    }

    await recordAudit(opts.db, {
      tenantId,
      adminId,
      action: "admin_invite.revoke",
      targetKind: "admin_invite",
      targetId: id,
      details: { email: outcome.email },
    });

    return c.json({ ok: true });
  });

  // Дополнительно — utility: pending-only list (для UI badge "N pending invites").
  void isNull;
  return app;
}
