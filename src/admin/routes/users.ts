import { ConversationsRepo } from "../../db/repos/conversations.ts";
import { LeadsRepo } from "../../db/repos/leads.ts";
import { MessagesRepo } from "../../db/repos/messages.ts";
import { UsersRepo } from "../../db/repos/users.ts";
import { json, type RouteHandler } from "../../router.ts";
import { requireAdmin } from "../auth.ts";
import type { AdminApiDeps } from "../shared.ts";

export function createListUsersHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.sql);
  return async ({ req }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    return json({ users: await users.list(500) });
  };
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
export function createUserDetailHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.sql);
  const conversations = new ConversationsRepo(deps.sql);
  const leads = new LeadsRepo(deps.sql);
  const messages = new MessagesRepo(deps.sql);
  return async ({ req, params }) => {
    const ctx = await requireAdmin(deps.sql, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
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
  };
}
