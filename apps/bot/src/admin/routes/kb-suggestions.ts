import { KbRepo } from "../../db/repos/kb.ts";
import { KbSuggestionsRepo, type SuggestionStatus } from "../../db/repos/kb-suggestions.ts";
import { MessagesRepo } from "../../db/repos/messages.ts";
import { ingestText } from "../../rag/ingest.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseIdParam, withAdmin } from "../handler-helpers.ts";
import type { AdminApiDeps } from "../shared.ts";

// ---------------------------------------------------------------------------
// KB Suggestions — unanswered questions → approval pipeline
// ---------------------------------------------------------------------------

export function createKbSuggestionCountsHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  return withAdmin(deps.sql, async () => {
    return json(await suggestions.countByStatus());
  });
}

export function createListKbSuggestionsHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ url }) => {
    const status = url.searchParams.get("status") as SuggestionStatus | null;
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const rows = await suggestions.list({ status: status ?? undefined, limit });
    return json({ suggestions: rows, counts: await suggestions.countByStatus() });
  });
}

export function createGetKbSuggestionHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  const messages = new MessagesRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const suggestion = await suggestions.byId(id);
    if (!suggestion) return json({ error: "not found" }, { status: 404 });
    const contextMessages = suggestion.source_conversation_id
      ? await messages.recentForContext(suggestion.source_conversation_id, 20)
      : [];
    return json({ suggestion, context_messages: contextMessages });
  });
}

export function createUpdateKbSuggestionHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const body = (await req.json()) as { answer_draft?: unknown };
    if (typeof body.answer_draft !== "string") {
      return json({ error: "answer_draft must be a string" }, { status: 400 });
    }
    const updated = await suggestions.setDraft(id, body.answer_draft);
    if (!updated) return json({ error: "not found" }, { status: 404 });
    return json({ suggestion: updated });
  });
}

export function createApproveKbSuggestionHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  const kb = new KbRepo(deps.sql);
  return withAdmin(deps.sql, async ({ params, admin }) => {
    if (!deps.rag) {
      return json(
        { error: "LLM not configured — cannot ingest without embedder" },
        { status: 503 },
      );
    }
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const suggestion = await suggestions.byId(id);
    if (!suggestion) return json({ error: "not found" }, { status: 404 });
    if (suggestion.status !== "pending") {
      return json({ error: "suggestion is not pending" }, { status: 409 });
    }
    if (!suggestion.answer_draft?.trim()) {
      return json(
        { error: "answer_draft is empty — add an answer before approving" },
        { status: 400 },
      );
    }

    const docBody = `Q: ${suggestion.question_text}\n\nA: ${suggestion.answer_draft.trim()}`;
    const doc = await ingestText(
      {
        title: suggestion.question_text.slice(0, 120),
        body: docBody,
      },
      { kb, embedder: deps.rag.embedder },
    );

    const updated = await suggestions.markIngested(id, admin.adminId, doc.documentId);
    return json({ suggestion: updated, kb_document_id: doc.documentId });
  });
}

export function createRejectKbSuggestionHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const updated = await suggestions.reject(id, admin.adminId, reason);
    if (!updated) return json({ error: "not found or already decided" }, { status: 404 });
    return json({ suggestion: updated });
  });
}

export function createCreateKbSuggestionHandler(deps: AdminApiDeps): RouteHandler {
  const suggestions = new KbSuggestionsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req }) => {
    const body = (await req.json()) as {
      question_text?: unknown;
      answer_draft?: unknown;
      source_conversation_id?: unknown;
    };
    if (typeof body.question_text !== "string" || !body.question_text.trim()) {
      return json({ error: "question_text is required" }, { status: 400 });
    }
    const sourceConvId =
      typeof body.source_conversation_id === "number" ? body.source_conversation_id : null;
    const suggestion = await suggestions.create({
      questionText: body.question_text.trim(),
      sourceConversationId: sourceConvId,
    });
    if (typeof body.answer_draft === "string" && body.answer_draft.trim()) {
      return json({
        suggestion: await suggestions.setDraft(suggestion.id, body.answer_draft.trim()),
      });
    }
    return json({ suggestion });
  });
}
