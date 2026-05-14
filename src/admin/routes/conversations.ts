import { AuditLogRepo } from "../../db/repos/audit-log.ts";
import { ConversationsRepo } from "../../db/repos/conversations.ts";
import { MessagesRepo } from "../../db/repos/messages.ts";
import { enqueue } from "../../db/repos/userbot-send-queue.ts";
import { UsersRepo } from "../../db/repos/users.ts";
import { inc } from "../../metrics.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseIdParam, parseJsonBody, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

export function createListConversationsHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ url }) => {
    const onlyEscalated = url.searchParams.get("escalated") === "1";
    return json({
      conversations: (await conversations.list({ onlyEscalated, limit: 200 })).map((row) => ({
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
  });
}

export function createConversationDetailHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.sql);
  const users = new UsersRepo(deps.sql);
  const messages = new MessagesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const conv = await conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    const user = await users.byId(conv.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });
    // Cross-session memory pulled from `users.profile_json.memory`. Always
    // included — when memory extraction is off (RAG_USER_MEMORY=false) this
    // is `{ facts: {} }` and the UI just shows an empty pane. Keeping the
    // shape stable on/off avoids a frontend feature flag.
    const memory = await users.getMemory(user.id);
    // Long-conversation summary (RAG_CONVERSATION_SUMMARY). Null when the
    // chat is too short to have triggered summarization yet, which the UI
    // handles by hiding the summary pane.
    const summary = await conversations.getSummary(id);
    return json({
      conversation: conv,
      user,
      messages: await messages.listByConversation(id, 200),
      memory,
      summary,
    });
  });
}

/**
 * Operator override of extracted candidate facts. Used when the LLM
 * extractor mis-attributes ("intent: путешествие" instead of "работа") —
 * operator edits replace stored memory wholesale (no merge), then the
 * next bot turn picks them up via the standard `getMemory` read path.
 */
export function createUpdateUserMemoryHandler(deps: AdminApiDeps): RouteHandler {
  const users = new UsersRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const user = await users.byId(id);
    if (!user) return json({ error: "not found" }, { status: 404 });

    const body = await parseJsonBody<{ facts?: unknown }>(req);
    if (body instanceof Response) return body;
    if (typeof body.facts !== "object" || body.facts === null || Array.isArray(body.facts)) {
      return json({ error: "facts must be an object" }, { status: 400 });
    }

    // Coerce: accept any-typed values from JSON (string|number|bool) and
    // normalize to string. Reject keys/values longer than reasonable —
    // memory is for facts, not pasted essays.
    const incoming = body.facts as Record<string, unknown>;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof k !== "string") continue;
      const trimmedKey = k.trim();
      if (!trimmedKey || trimmedKey.length > 40) continue;
      if (v === null || v === undefined) continue;
      const str = typeof v === "string" ? v : String(v);
      const trimmed = str.trim();
      if (!trimmed || trimmed.length > 200) continue;
      cleaned[trimmedKey] = trimmed;
    }

    await users.setMemoryFacts(id, cleaned);
    return json({ memory: await users.getMemory(id) });
  });
}

export function createTakeHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const conv = await conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    await conversations.setMode(id, "human", admin.adminId);
    deps.onConversationChanged?.(id);
    const updated = await conversations.byId(id);
    return json({ conversation: updated });
  });
}

export function createReleaseHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const conv = await conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    await conversations.setMode(id, "ai");
    deps.onConversationChanged?.(id);
    const updated = await conversations.byId(id);
    return json({ conversation: updated });
  });
}

export function createDeleteConversationHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const conv = await conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    const ok = await conversations.deleteById(id);
    if (!ok) return json({ error: "delete failed" }, { status: 500 });
    deps.onConversationChanged?.(id);
    await new AuditLogRepo(deps.sql)
      .write({
        action: "conversation.delete",
        adminId: admin.adminId,
        targetKind: "conversation",
        targetId: id,
      })
      .catch((err) => console.error("[audit] conversation.delete write failed:", err));
    return json({ ok: true, deleted: id });
  });
}

export function createReplyHandler(deps: AdminApiDeps): RouteHandler {
  const conversations = new ConversationsRepo(deps.sql);
  const messages = new MessagesRepo(deps.sql);
  const users = new UsersRepo(deps.sql);

  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const conv = await conversations.byId(id);
    if (!conv) return json({ error: "not found" }, { status: 404 });
    if (conv.mode !== "human") {
      return json({ error: "conversation is not in human mode" }, { status: 409 });
    }

    const body = await parseJsonBody<{ text?: unknown }>(req);
    if (body instanceof Response) return body;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "text is required" }, { status: 400 });

    const user = await users.byId(conv.user_id);
    if (!user) return json({ error: "user not found" }, { status: 404 });

    let tgMessageId: number | undefined;
    let tgError: string | undefined;
    if (deps.userbotEnabled) {
      // Route through the userbot send queue — message will appear from Alina's account.
      await enqueue(deps.sql, user.tg_user_id, text).catch((err) => {
        tgError = err instanceof Error ? err.message : String(err);
        console.error("[admin reply] userbot enqueue failed:", err);
      });
      if (!tgError) inc("tg_replies_total", 1, { source: "admin_userbot" });
    } else if (deps.telegram) {
      try {
        const sent = await deps.telegram.sendMessage({
          chatId: user.tg_user_id,
          text,
        });
        tgMessageId = sent.message_id;
        inc("tg_replies_total", 1, { source: "admin_bot" });
      } catch (err) {
        tgError = err instanceof Error ? err.message : String(err);
        console.error("[admin reply] Telegram send failed:", err);
      }
    } else {
      console.warn(
        "[admin reply] no send path: userbotEnabled=false and telegram=undefined — message saved to DB only",
      );
    }

    await messages.add({
      conversationId: id,
      role: "human",
      text,
      tgMessageId,
    });
    await conversations.touch(id);

    deps.onMessageSent?.({ conversationId: id, tgUserId: user.tg_user_id });

    // Message is saved to DB regardless of Telegram delivery. Return 200 so
    // the client clears the input and reloads; surface tgError as a warning
    // field so the admin UI can optionally toast about it without blocking.
    return json({ ok: true, conversationId: id, tgUserId: user.tg_user_id, tgError });
  });
}
