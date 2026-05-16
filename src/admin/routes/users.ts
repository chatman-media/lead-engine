import { AuditLogRepo } from "../../db/repos/audit-log.ts";
import { ConversationsRepo } from "../../db/repos/conversations.ts";
import { LeadsRepo } from "../../db/repos/leads.ts";
import { MessagesRepo } from "../../db/repos/messages.ts";
import { UsersRepo } from "../../db/repos/users.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseIdParam, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

export function createListUsersHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.sql);
  return withAdmin(deps.sql, async () => {
    return json({ users: await users.list(500) });
  });
}

/**
 * Detail dossier for a single user — combines profile, conversation pointer,
 * lead state, memory facts, and a recent-messages tail. Operators land here
 * when they need a "who is this person" view that's broader than a single
 * conversation thread (memory facts come from past sessions; the lead row
 * may pre-date the current conversation).
 *
 * Designed so the page makes ONE HTTP call — no waterfall — at the cost of
 * a bigger response. Last 30 messages is the cap; full history lives in
 * /admin/chats/:id (the conversation view).
 */
/**
 * GDPR right-to-erasure: delete every row that holds personal data about
 * a candidate (passport / national id / name / phone / messages / lead
 * pipeline state / memory facts). The `users` row itself is wiped to a
 * tombstone (kept so foreign-key chains that point to it stay valid,
 * but every PII column is set to NULL / placeholder).
 *
 * Cascade chain (ON DELETE CASCADE in pg_schema.sql):
 *   user → conversations → messages
 *   user → leads → lead_events / lead_notes
 *
 * Vacancies / KB / styles are NOT user-scoped — untouched.
 */
export function createDeleteUserDataHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const user = await users.byId(id);
    if (!user) return json({ error: "not found" }, { status: 404 });

    // Hand off to a single transaction so a partial cascade doesn't
    // leave the user in an inconsistent half-anonymised state.
    const summary = await deps.sql.begin(async (tx) => {
      // Cascade-delete via parent rows. ON DELETE CASCADE in pg_schema.sql
      // takes care of conversations → messages and leads → events/notes.
      const convRes = await tx`DELETE FROM conversations WHERE user_id = ${id}`;
      const leadRes = await tx`DELETE FROM leads WHERE user_id = ${id}`;
      // Tombstone the user row: keep the id for referential integrity but
      // strip every identifying field. `tg_user_id` is NOT NULL so use a
      // sentinel value derived from the row id (always negative + unique).
      await tx`
        UPDATE users
        SET tg_user_id = ${-id},
            tg_username = NULL,
            status = 'lost',
            profile_json = NULL,
            updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
        WHERE id = ${id}
      `;
      return {
        conversations_deleted: convRes.count,
        leads_deleted: leadRes.count,
      };
    });

    // GDPR audit trail — who erased which user. Best-effort, don't fail
    // the operation if the audit write itself blows up.
    await new AuditLogRepo(deps.sql)
      .write({
        action: "user.gdpr_erase",
        adminId: admin.adminId,
        targetKind: "user",
        targetId: id,
        details: summary,
      })
      .catch((err) => console.error("[audit] user.gdpr_erase write failed:", err));

    return json({ ok: true, user_id: id, ...summary });
  });
}

export function createUserDetailHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.sql);
  const conversations = new ConversationsRepo(deps.sql);
  const leads = new LeadsRepo(deps.sql);
  const messages = new MessagesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const user = await users.byId(id);
    if (!user) return json({ error: "not found" }, { status: 404 });
    const conversation = await conversations.byUserId(id);
    const lead = await leads.byUserId(id);
    const memory = await users.getMemory(id);
    const recentMessages = conversation
      ? (await messages.listByConversation(conversation.id, 30)).map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          tg_message_id: m.tg_message_id,
          created_at: m.created_at,
        }))
      : [];
    return json({
      user,
      conversation,
      lead,
      memory,
      recent_messages: recentMessages,
    });
  });
}
