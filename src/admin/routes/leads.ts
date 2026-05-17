import { AuditLogRepo } from "../../db/repos/audit-log.ts";
import { ConversationsRepo } from "../../db/repos/conversations.ts";
import { type LeadState, LeadsRepo } from "../../db/repos/leads.ts";
import { MessagesRepo } from "../../db/repos/messages.ts";
import { UsersRepo } from "../../db/repos/users.ts";
import { fillIntakeTemplate, type IntakeFields } from "../../leads/templates.ts";
import { json, type RouteHandler } from "../../router.ts";
import { parseIdParam, parseJsonBody, withAdmin } from "../handler-helpers.ts";
import {
  type AdminApiDeps,
  buildLeadsService,
  recentMessagesForCard,
  runAttribution,
  safeJson,
} from "../shared.ts";

// ─── Leads (lead pipeline / approval gate / docs collection) ───────────

const LEAD_STATES: LeadState[] = [
  "intake_pending",
  "intake_complete",
  "approved",
  "partner_review",
  "rejected",
  "docs_pending",
  "docs_complete",
  "submitted",
  "ready_to_work",
  "closed",
];

export function createListLeadsHandler(deps: AdminApiDeps): RouteHandler {
  const leads = new LeadsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ url }) => {
    const stateParam = url.searchParams.get("state");
    const state =
      stateParam && (LEAD_STATES as string[]).includes(stateParam)
        ? (stateParam as LeadState)
        : null;
    return json({
      leads: await leads.list({ ...(state ? { state } : {}) }),
      counts: await leads.countByState(),
    });
  });
}

/**
 * Promote an existing conversation to a lead (or return the existing one).
 * Idempotent — calling twice on the same conversation returns the same
 * lead row. When LEADS_CHAT_ID is configured, also posts the lead card
 * with approve/reject buttons.
 */
export function createPromoteLeadHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const convId = parseIdParam(params);
    if (convId instanceof Response) return convId;

    const conversations = new ConversationsRepo(deps.sql);
    const users = new UsersRepo(deps.sql);
    const leadsRepo = new LeadsRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);

    const conv = await conversations.byId(convId);
    if (!conv) return json({ error: "conversation not found" }, { status: 404 });
    const user = await users.byId(conv.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });

    let lead = await leadsRepo.ensureForUser(user.id);
    // Promotion implies "ready for operator decision" — bump intake state.
    if (lead.state === "intake_pending") {
      lead = (await leadsRepo.setState(lead.id, "intake_complete")) ?? lead;
    }

    const service = buildLeadsService(deps);
    if (service) {
      lead = await service.postCardToOpsChat({
        lead,
        user,
        recentMessages: await recentMessagesForCard(messagesRepo, conv.id),
      });
      // Notify the candidate that the request is being reviewed — this
      // matches the operator's stock "отправила запрос в клуб" message.
      await service.sendAwaitingApprovalNote({ user });
    }
    deps.onConversationChanged?.(conv.id);
    return json({ lead });
  });
}

export function createApproveLeadHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);
    const conversations = new ConversationsRepo(deps.sql);

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    if (lead.state === "approved" || lead.state === "rejected") {
      return json({ error: `lead already ${lead.state}` }, { status: 409 });
    }
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });

    const updated = await leadsRepo.setState(id, "approved", { adminId: admin.adminId });
    if (!updated) return json({ error: "transition failed" }, { status: 500 });
    // Move into docs_pending — bot will start collecting visa form.
    const inDocs = (await leadsRepo.setState(id, "docs_pending")) ?? updated;

    const service = buildLeadsService(deps);
    if (service) {
      await service.sendApprovalMessages({ lead: inDocs, user });
      const conv = await conversations.byUserId(user.id);
      if (conv) {
        await service.refreshOpsCard({
          lead: inDocs,
          user,
          recentMessages: await recentMessagesForCard(messagesRepo, conv.id),
          decision: { state: "approved" },
        });
      }
    }
    return json({ lead: inDocs });
  });
}

export function createRejectLeadHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    let body: { reason?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // Optional body — empty is fine, default rejection text is used.
    }
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);
    const conversations = new ConversationsRepo(deps.sql);

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    if (lead.state === "approved" || lead.state === "rejected") {
      return json({ error: `lead already ${lead.state}` }, { status: 409 });
    }
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });

    const rejectedReasonOpt: { rejectedReason?: string } = reason ? { rejectedReason: reason } : {};
    const updated = await leadsRepo.setState(id, "rejected", {
      adminId: admin.adminId,
      ...rejectedReasonOpt,
    });
    if (!updated) return json({ error: "transition failed" }, { status: 500 });
    runAttribution(deps, updated);

    const service = buildLeadsService(deps);
    if (service) {
      await service.sendRejection({
        user,
        ...(reason ? { customReason: reason } : {}),
      });
      const conv = await conversations.byUserId(user.id);
      if (conv) {
        await service.refreshOpsCard({
          lead: updated,
          user,
          recentMessages: await recentMessagesForCard(messagesRepo, conv.id),
          decision: { state: "rejected" },
        });
      }
    }
    return json({ lead: updated });
  });
}

/** Operator clicks "send intake" — bot DMs the candidate the 15-item
 *  checklist. The operator usually reviews/edits a partially-filled
 *  version first (see `createIntakePreviewHandler`) and passes the final
 *  text in the body; when the body has no `text`, the partially-filled
 *  template is composed server-side. Language via `?lang=ru|en`. */
export function createSendIntakeHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, params, url }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const lang = url.searchParams.get("lang") === "en" ? "en" : "ru";

    let body: { text?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // Optional body — when absent the partially-filled template is composed.
    }

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });

    const intake = lead.intake_json ? (safeJson(lead.intake_json) as IntakeFields | null) : null;
    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text
        : fillIntakeTemplate(intake ?? {}, lang);

    const service = buildLeadsService(deps);
    if (!service) {
      return json({ error: "telegram client not configured" }, { status: 503 });
    }
    await service.sendIntakeTemplate({ user, text });
    return json({ ok: true });
  });
}

/** Side-effect-free preview of the partially-filled intake checklist —
 *  the blank template with bot-extracted answers appended inline. The
 *  admin UI loads this into an editable textarea before sending. */
export function createIntakePreviewHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params, url }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const lang = url.searchParams.get("lang") === "en" ? "en" : "ru";

    const leadsRepo = new LeadsRepo(deps.sql);
    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });

    const intake = lead.intake_json ? (safeJson(lead.intake_json) as IntakeFields | null) : null;
    return json({ text: fillIntakeTemplate(intake ?? {}, lang) });
  });
}

/**
 * Phase 2C: hand off a lead to the visa-submission queue. Allocates a
 * sequential application_id, posts the package to VISA_CHAT_ID, and
 * transitions the lead into `docs_complete`. Bot DMs the candidate
 * a "your file is being submitted" ack.
 *
 * Idempotent on application_id allocation — calling twice returns the
 * same id. State guard: must be in approved / docs_pending / docs_complete.
 */
export function createSubmitToVisaHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);
    const conversations = new ConversationsRepo(deps.sql);

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    if (
      lead.state !== "approved" &&
      lead.state !== "docs_pending" &&
      lead.state !== "docs_complete"
    ) {
      return json(
        { error: `lead state ${lead.state} cannot be submitted to visa` },
        { status: 409 },
      );
    }
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });

    const applicationId = await leadsRepo.allocateApplicationId(id);
    const transitioned = (await leadsRepo.setState(id, "docs_complete")) ?? lead;
    runAttribution(deps, transitioned);

    const service = buildLeadsService(deps);
    if (service) {
      const conv = await conversations.byUserId(user.id);
      if (conv) {
        await service.postVisaSubmissionPackage({
          lead: transitioned,
          user,
          recentMessages: await recentMessagesForCard(messagesRepo, conv.id),
          applicationId,
        });
      }
      // Acknowledge to the candidate so they're not left in the dark.
      await service.sendDocsCompleteAck({ user });
    }
    return json({ lead: transitioned, application_id: applicationId });
  });
}

/**
 * Mark a lead as `submitted` — the operator has actually filed the visa
 * application with the consulate. This is the step after `→ visa submit`
 * (which only posts the package to VISA_CHAT_ID and lands the lead in
 * `docs_complete`). Sends the candidate the promised "заявка подана"
 * message with her application id. The conversation stays in `ai` mode —
 * the bot keeps answering her questions during the consulate wait.
 *
 * State guard: must be in `docs_complete`. A re-call on an already
 * `submitted` lead is idempotent (200, no duplicate message).
 */
export function createMarkSubmittedHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    if (lead.state === "submitted") {
      return json({ lead, application_id: lead.application_id });
    }
    if (lead.state !== "docs_complete") {
      return json(
        { error: `lead state ${lead.state} cannot be marked submitted` },
        { status: 409 },
      );
    }
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });

    // docs_complete always carries an application_id (submit-to-visa
    // allocates it); allocate defensively just in case.
    const applicationId = lead.application_id ?? (await leadsRepo.allocateApplicationId(id));
    const transitioned = (await leadsRepo.setState(id, "submitted")) ?? lead;
    runAttribution(deps, transitioned);

    const service = buildLeadsService(deps);
    if (service) {
      await service.sendSubmittedAck({ user, applicationId });
    }
    return json({ lead: transitioned, application_id: applicationId });
  });
}

/**
 * Single-lead detail. Returns the lead row joined with the user info,
 * plus parsed `intake` and `visa_docs` so the UI doesn't have to
 * re-parse JSON in the browser, plus the most recent ~30 messages.
 */
export function createLeadDetailHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const conversations = new ConversationsRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });
    const conv = await conversations.byUserId(user.id);
    return json({
      lead,
      user,
      intake: lead.intake_json ? safeJson(lead.intake_json) : null,
      visa_docs: lead.visa_docs_json ? safeJson(lead.visa_docs_json) : null,
      conversation_id: conv?.id ?? null,
      recent_messages: conv ? await recentMessagesForCard(messagesRepo, conv.id) : [],
      events: await leadsRepo.events(id),
      notes: await leadsRepo.notes(id),
    });
  });
}

/**
 * All media (photos / videos / documents) a candidate sent, for the
 * leads page. The operator clicks a media tag on the lead card and gets
 * the actual files inline. Returns `{ media: [] }` when the lead has no
 * conversation yet.
 */
export function createLeadMediaHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const conversations = new ConversationsRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return json({ error: "user gone" }, { status: 404 });
    const conv = await conversations.byUserId(user.id);
    return json({
      media: conv ? await messagesRepo.mediaForConversation(conv.id) : [],
    });
  });
}

const NOTE_BODY_MAX = 2000;

/** Append a note to a lead. Body required; admin id is taken from the
 *  authenticated session so the note carries an attribution row. */
export function createCreateLeadNoteHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ req, params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const leadsRepo = new LeadsRepo(deps.sql);
    if (!(await leadsRepo.byId(id))) {
      return json({ error: "lead not found" }, { status: 404 });
    }

    const body = await parseJsonBody<{ body?: unknown }>(req);
    if (body instanceof Response) return body;
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) return json({ error: "body is required" }, { status: 400 });
    if (text.length > NOTE_BODY_MAX) {
      return json({ error: `body > ${NOTE_BODY_MAX} chars` }, { status: 400 });
    }

    const note = await leadsRepo.addNote({
      leadId: id,
      body: text,
      byAdminId: admin.adminId,
    });
    return json({ note });
  });
}

/** Hard-delete a note. Operator can clean up typos / mistaken entries.
 *  Belongs-to check: the note must reference the lead in the URL, not
 *  some other lead — prevents cross-lead deletion via guessed note ids. */
export function createDeleteLeadNoteHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params }) => {
    const leadId = Number(params.id);
    const noteId = Number(params.noteId);
    if (!Number.isFinite(leadId) || !Number.isFinite(noteId)) {
      return json({ error: "bad id" }, { status: 400 });
    }

    const [ownerRow] = await deps.sql<{ lead_id: number }[]>`
      SELECT lead_id FROM lead_notes WHERE id = ${noteId}
    `;
    if (!ownerRow) return json({ error: "note not found" }, { status: 404 });
    if (ownerRow.lead_id !== leadId) {
      return json({ error: "note does not belong to this lead" }, { status: 404 });
    }

    const leadsRepo = new LeadsRepo(deps.sql);
    await leadsRepo.deleteNote(noteId);
    return json({ ok: true, deleted: noteId });
  });
}

const VISA_DOCS_FIELD_KEYS = [
  "family_name",
  "given_name",
  "date_of_birth",
  "country_of_birth",
  "birth_province",
  "city_of_birth",
  "marital_status",
  "current_nationality",
  "national_id_number",
  "other_nationalities",
  "other_permanent_residence",
  "held_other_nationalities",
  "passport_number",
  "passport_issuing_country",
  "passport_issuing_place",
  "passport_expiration_date",
  "current_address",
  "phone",
  "mobile_phone",
  "email",
  "father_name",
  "father_nationality",
  "father_dob",
  "mother_name",
  "mother_nationality",
  "mother_dob",
  "been_to_china",
  "previous_chinese_visa",
  "work_experience",
  "education",
  "travel_history_12mo",
  "family_other",
] as const;
const VISA_DOCS_FIELD_KEY_SET: ReadonlySet<string> = new Set(VISA_DOCS_FIELD_KEYS);
const VISA_DOCS_VALUE_MAX = 1500;

/**
 * Operator-driven manual edit of the auto-extracted visa-application
 * fields. The body shape is `{ docs: { field: value, ... } }` — only
 * known keys are accepted (others silently dropped); an empty-string
 * value clears the field. The update is MERGED on top of existing
 * stored docs so the operator can fix one field without retyping all.
 */
export function createUpdateVisaDocsHandler(deps: AdminApiDeps): RouteHandler {
  const leadsRepo = new LeadsRepo(deps.sql);
  return withAdmin(deps.sql, async ({ req, params }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;

    const lead = await leadsRepo.byId(id);
    if (!lead) return json({ error: "not found" }, { status: 404 });

    const body = await parseJsonBody<{ docs?: unknown }>(req);
    if (body instanceof Response) return body;
    if (typeof body.docs !== "object" || body.docs === null || Array.isArray(body.docs)) {
      return json({ error: "docs must be an object" }, { status: 400 });
    }

    const incoming = body.docs as Record<string, unknown>;
    const existing = (lead.visa_docs_json ? safeJson(lead.visa_docs_json) : {}) as Record<
      string,
      string
    >;
    const merged: Record<string, string> = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      if (!VISA_DOCS_FIELD_KEY_SET.has(k)) continue;
      if (v === null || v === undefined) {
        delete merged[k];
        continue;
      }
      const str = typeof v === "string" ? v : String(v);
      const trimmed = str.trim();
      if (!trimmed) {
        delete merged[k];
        continue;
      }
      if (trimmed.length > VISA_DOCS_VALUE_MAX) continue;
      merged[k] = trimmed;
    }

    await leadsRepo.setVisaDocs(id, JSON.stringify(merged));
    return json({ visa_docs: merged });
  });
}

export function createDeleteLeadHandler(deps: AdminApiDeps): RouteHandler {
  return withAdmin(deps.sql, async ({ params, admin }) => {
    const id = parseIdParam(params);
    if (id instanceof Response) return id;
    const leadsRepo = new LeadsRepo(deps.sql);
    const ok = await leadsRepo.delete(id);
    if (!ok) return json({ error: "not found" }, { status: 404 });
    await new AuditLogRepo(deps.sql)
      .write({ action: "lead.delete", adminId: admin.adminId, targetKind: "lead", targetId: id })
      .catch((err) => console.error("[audit] lead.delete write failed:", err));
    return json({ ok: true, deleted: id });
  });
}

/**
 * The Telegram callback_query handler. Dispatches lead approve/reject
 * inline-button clicks to the right service action. Handed to the
 * webhook via WebhookDeps.onCallbackQuery.
 *
 * Returns a function (not a RouteHandler) — the webhook calls it
 * directly with the parsed callback_query.
 */
export function createLeadCallbackHandler(deps: AdminApiDeps) {
  return async (query: import("../../telegram/types.ts").TgCallbackQuery): Promise<void> => {
    if (!deps.telegram) return;
    const data = query.data ?? "";
    const match = /^lead:(approve|reject):(\d+)$/.exec(data);
    if (!match) return;
    const action = match[1] as "approve" | "reject";
    const leadId = Number(match[2]);

    const leadsRepo = new LeadsRepo(deps.sql);
    const usersRepo = new UsersRepo(deps.sql);
    const messagesRepo = new MessagesRepo(deps.sql);
    const conversations = new ConversationsRepo(deps.sql);

    const lead = await leadsRepo.byId(leadId);
    if (!lead) {
      await deps.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Лид не найден",
        showAlert: true,
      });
      return;
    }
    if (lead.state === "approved" || lead.state === "rejected") {
      await deps.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: `Уже ${lead.state === "approved" ? "одобрен" : "отклонён"}`,
      });
      return;
    }
    const user = await usersRepo.byId(lead.user_id);
    if (!user) return;

    const service = buildLeadsService(deps);
    if (!service) return;

    if (action === "approve") {
      const approved = (await leadsRepo.setState(leadId, "approved")) ?? lead;
      const inDocs = (await leadsRepo.setState(leadId, "docs_pending")) ?? approved;
      await service.sendApprovalMessages({ lead: inDocs, user });
      const conv = await conversations.byUserId(user.id);
      if (conv) {
        await service.refreshOpsCard({
          lead: inDocs,
          user,
          recentMessages: await recentMessagesForCard(messagesRepo, conv.id),
          decision: { state: "approved" },
        });
      }
      await deps.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Одобрено ✅",
      });
    } else {
      const rejected = (await leadsRepo.setState(leadId, "rejected")) ?? lead;
      runAttribution(deps, rejected);
      await service.sendRejection({ user });
      const conv = await conversations.byUserId(user.id);
      if (conv) {
        await service.refreshOpsCard({
          lead: rejected,
          user,
          recentMessages: await recentMessagesForCard(messagesRepo, conv.id),
          decision: { state: "rejected" },
        });
      }
      await deps.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Отклонено ❌",
      });
    }
  };
}
