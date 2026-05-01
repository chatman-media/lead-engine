import type { Database } from "bun:sqlite";

import { ConversationsRepo } from "../db/repos/conversations.ts";
import { MessagesRepo } from "../db/repos/messages.ts";
import { UsersRepo } from "../db/repos/users.ts";
import { json, type RouteHandler } from "../router.ts";
import type { TelegramClient } from "../telegram/client.ts";
import { requireAdmin } from "./auth.ts";

export interface AdminApiDeps {
  db: Database;
  telegram?: TelegramClient;
  /** Optional event hooks for the websocket layer (or other listeners). */
  onConversationChanged?: (conversationId: number) => void;
  onMessageSent?: (input: { conversationId: number; tgUserId: number }) => void;
}

export function createListUsersHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    return json({ users: users.list(500) });
  };
}

export function createListConversationsHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const url = new URL(req.url);
    const onlyEscalated = url.searchParams.get("escalated") === "1";
    return json({
      conversations: conversations
        .list({ onlyEscalated, limit: 200 })
        .map((row) => ({
          id: row.id,
          mode: row.mode,
          escalated_at: row.escalated_at,
          last_message_at: row.last_message_at,
          assigned_admin_id: row.assigned_admin_id,
          user: {
            id: row.user_id,
            tg_user_id: row.tg_user_id,
            tg_username: row.tg_username,
          },
        })),
    });
  };
}

export function createConversationDetailHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  const users = new UsersRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    const user = users.byId(conv.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });
    return json({
      conversation: conv,
      user,
      messages: messages.listByConversation(id, 200),
    });
  };
}

export function createTakeHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    conversations.setMode(id, "human", ctx.adminId);
    deps.onConversationChanged?.(id);
    const updated = conversations.byId(id);
    return json({ conversation: updated });
  };
}

export function createReleaseHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    conversations.setMode(id, "ai");
    deps.onConversationChanged?.(id);
    const updated = conversations.byId(id);
    return json({ conversation: updated });
  };
}

export function createDeleteConversationHandler(
  deps: AdminApiDeps,
): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  return ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });
    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    const ok = conversations.deleteById(id);
    if (!ok) return json({ error: "delete failed" }, { status: 500 });
    deps.onConversationChanged?.(id);
    return json({ ok: true, deleted: id });
  };
}

export function createReplyHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.db);
  const messages = new MessagesRepo(deps.db);
  const users = new UsersRepo(deps.db);

  return async ({ req, params }) => {
    const ctx = requireAdmin(deps.db, req);
    if (ctx instanceof Response) return ctx;

    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ error: "bad id" }, { status: 400 });

    const conv = conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    if (conv.mode !== "human") {
      return json(
        { error: "conversation is not in human mode" },
        { status: 409 },
      );
    }

    let body: { text?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "invalid JSON" }, { status: 400 });
    }
    const text =
      typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text is required" }, { status: 400 });

    const user = users.byId(conv.user_id);
    if (!user) return json({ error: "user not found" }, { status: 404 });

    let tgMessageId: number | undefined;
    if (deps.telegram) {
      try {
        const sent = await deps.telegram.sendMessage({
          chatId: user.tg_user_id,
          text,
        });
        tgMessageId = sent.message_id;
      } catch (err) {
        console.error("[admin reply] Telegram send failed:", err);
      }
    }

    messages.add({
      conversationId: id,
      role: "human",
      text,
      tgMessageId,
    });
    conversations.touch(id);

    deps.onMessageSent?.({ conversationId: id, tgUserId: user.tg_user_id });

    return json({ ok: true, conversationId: id, tgUserId: user.tg_user_id });
  };
}
