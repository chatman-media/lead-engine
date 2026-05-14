import {
  createAnalyticsHandler,
  createApplyCoachProposalHandler,
  createApproveKbSuggestionHandler,
  createApproveLeadHandler,
  createBulkExportConversationsHandler,
  createConversationDetailHandler,
  createCreateExperimentHandler,
  createCreateKbSuggestionHandler,
  createCreateLeadNoteHandler,
  createCreateStyleHandler,
  createCreateVacancyHandler,
  createDecideCoachProposalHandler,
  createDeleteCoachProposalHandler,
  createDeleteConversationHandler,
  createDeleteKbDocumentHandler,
  createDeleteLeadHandler,
  createDeleteLeadNoteHandler,
  createDeletePairwiseMatchHandler,
  createDeleteSelfPlayMatchHandler,
  createDeleteVacancyHandler,
  createDownloadFileHandler,
  createEditStyleHandler,
  createExperimentFunnelHandler,
  createExportConversationHandler,
  createGetCoachProposalHandler,
  createGetKbDocumentHandler,
  createGetKbSuggestionHandler,
  createGetPairwiseMatchHandler,
  createGetSelfPlayMatchHandler,
  createGetShadowEvalHandler,
  createGetStyleHandler,
  createGetStyleSkillsHandler,
  createIngestKbDocumentHandler,
  createKbSuggestionCountsHandler,
  createLeadCallbackHandler,
  createLeadDetailHandler,
  createListCoachProposalsHandler,
  createListConversationsHandler,
  createListExperimentsHandler,
  createListKbDocumentsHandler,
  createListKbSuggestionsHandler,
  createListLeadsHandler,
  createListPairwiseMatchesHandler,
  createListSelfPlayMatchesHandler,
  createListSkillsHandler,
  createListStyleRatingsHandler,
  createListStylesHandler,
  createListUsersHandler,
  createListVacanciesHandler,
  createPromoteLeadHandler,
  createRecommendSkillsHandler,
  createRejectKbSuggestionHandler,
  createRejectLeadHandler,
  createReleaseHandler,
  createReplyHandler,
  createRollbackCoachProposalHandler,
  createRunCoachHandler,
  createSendIntakeHandler,
  createSetExperimentStatusHandler,
  createSetStyleSkillsHandler,
  createStartShadowEvalHandler,
  createStatusHandler,
  createStylePlaygroundHandler,
  createSubmitToVisaHandler,
  createTakeHandler,
  createUpdateKbDocumentHandler,
  createUpdateKbSuggestionHandler,
  createUpdateSkillHandler,
  createUpdateUserMemoryHandler,
  createUpdateVacancyHandler,
  createUpdateVisaDocsHandler,
  createUploadBookHandler,
  createUserDetailHandler,
} from "./admin/api.ts";
import { createLoginHandler, createLogoutHandler, createMeHandler } from "./admin/auth.ts";
import type { AdminBus } from "./admin/bus.ts";
import { config } from "./config.ts";
import type { Sql } from "./db/postgres.ts";
import { renderPrometheus } from "./metrics.ts";
import { createQuestionnaireGet, createQuestionnairePost } from "./questionnaire/routes.ts";
import { clientIp, RateLimiter } from "./rate-limit.ts";
import { html, json, type RouteHandler, Router } from "./router.ts";
import type { TelegramClient } from "./telegram/client.ts";
import { createWebhookHandler, type RagDeps } from "./telegram/webhook.ts";
import { mountTestHooks } from "./test-hooks.ts";

export interface AppDeps {
  sql: Sql;
  telegram: TelegramClient;
  webhookSecret: string;
  rag?: RagDeps;
  /** Optional pub/sub for the websocket layer. */
  bus?: AdminBus;
  /** Mounts /__test/* routes for Playwright; never enable in production. */
  enableTestHooks?: boolean;
  /** When true, the Telegram webhook awaits the full RAG/sendMessage
   *  pipeline before responding. Tests use this for deterministic
   *  assertions; production keeps it false (fire-and-forget) so we
   *  ack Bot API in <100ms and avoid retry storms. */
  awaitWebhookProcessing?: boolean;
  /** Group chat where new lead cards are posted (with approve/reject
   *  inline buttons). Optional — when unset, no TG card is posted but
   *  the admin UI flow still works. */
  leadsChatId?: number | null;
  /** Group chat where the visa-submission package is posted. */
  visaChatId?: number | null;
}

// Rate limiters shared across the request lifetime. Telegram webhook is
// generously sized (a busy chat can burst dozens of updates in a second),
// admin login is tight to thwart credential stuffing. Disabled during
// tests — fake "unknown" client IP would share one bucket and break
// suites that hit the login endpoint repeatedly.
const RATE_LIMIT_DISABLED =
  process.env.TEST_HOOKS === "1" ||
  process.env.NODE_ENV === "test" ||
  process.env.BUN_ENV === "test" ||
  process.env.RATE_LIMIT_DISABLED === "1";
const webhookLimiter = new RateLimiter({ capacity: 60, refillPerSec: 30 });
const adminLoginLimiter = new RateLimiter({ capacity: 10, refillPerSec: 0.5 });

function rateLimited(
  limiter: RateLimiter,
  keyFn: (req: Request) => string,
  inner: RouteHandler,
): RouteHandler {
  if (RATE_LIMIT_DISABLED) return inner;
  return async (ctx) => {
    const key = keyFn(ctx.req);
    if (!limiter.check(key)) {
      return json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "1" } });
    }
    return inner(ctx);
  };
}

export function createRouter(deps: AppDeps): Router {
  const router = new Router();

  router.get("/health", () =>
    html(
      `<!doctype html><html><head><meta charset="utf-8"><title>tg-chatbot health</title></head><body><main id="health">ok</main></body></html>`,
    ),
  );

  // Prometheus text-format scrape endpoint. Unauthenticated by design —
  // counters are non-sensitive, and the reverse proxy typically restricts
  // /metrics to the monitoring VPC. If exposed publicly, place behind
  // basic auth at the proxy layer.
  router.get("/metrics", () => {
    const body = renderPrometheus();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  });

  router.get("/", () =>
    html(
      `<!doctype html><html><head><meta charset="utf-8"><title>tg-chatbot</title></head><body><h1>tg-chatbot</h1></body></html>`,
    ),
  );

  // Eagerly build the leads-callback handler so the webhook can dispatch
  // inline-keyboard clicks. Built outside the route closure so apiDeps
  // is captured by reference once.
  // Wrap the webhook in a per-IP token bucket — protection in case the
  // secret URL leaks (a third party could otherwise flood the bot).
  router.post(
    "/telegram/:secret",
    rateLimited(
      webhookLimiter,
      clientIp,
      createWebhookHandler({
        db: deps.sql,
        telegram: deps.telegram,
        webhookSecret: deps.webhookSecret,
        rag: deps.rag,
        awaitProcessing: deps.awaitWebhookProcessing,
        // leadsChatId / visaChatId need to flow into the webhook itself
        // (auto-intake gate, reply-to-card relay detection), not just
        // the callback-query handler. Without this, runIntakeUpdate
        // early-returns on `leadsChatId == null` and no auto-promotion
        // ever happens — silently.
        leadsChatId: deps.leadsChatId ?? null,
        visaChatId: deps.visaChatId ?? null,
        onCallbackQuery: createLeadCallbackHandler({
          sql: deps.sql,
          telegram: deps.telegram,
          leadsChatId: deps.leadsChatId ?? null,
          visaChatId: deps.visaChatId ?? null,
        }),
        onEvent: (event) => {
          switch (event.type) {
            case "user-message-persisted":
            case "assistant-replied":
              deps.bus?.publish({
                type: "message:new",
                conversationId: event.conversationId,
                tgUserId: event.tgUserId,
              });
              return;
            case "conversation-mode-changed":
              deps.bus?.publish({
                type: "conversation:updated",
                conversationId: event.conversationId,
              });
              return;
            case "kb-suggestion:created": {
              deps.bus?.publish({
                type: "kb-suggestion:created",
                suggestionId: event.suggestionId,
                conversationId: event.conversationId,
              });
              // DM the admin in Telegram so they can jump to the chat immediately.
              const adminTgId = config.admin.tgUserId;
              if (adminTgId) {
                const adminUrl = `${config.publicBaseUrl}/admin/kb-suggestions`;
                deps.telegram
                  .sendMessage({
                    chatId: adminTgId,
                    text: `❓ Новый вопрос без ответа (conversation #${event.conversationId})\n\nОткрыть: ${adminUrl}`,
                  })
                  .catch(() => undefined);
              }
              return;
            }
          }
        },
      }),
    ),
  );

  router.get("/q/:token", createQuestionnaireGet(deps.sql));
  router.post("/q/:token", createQuestionnairePost(deps.sql));

  router.post(
    "/admin/api/login",
    rateLimited(adminLoginLimiter, clientIp, createLoginHandler(deps.sql)),
  );
  router.post("/admin/api/logout", createLogoutHandler(deps.sql));
  router.get("/admin/api/me", createMeHandler(deps.sql));

  const apiDeps = {
    sql: deps.sql,
    telegram: deps.telegram,
    userbotEnabled: config.userbot.enabled,
    // Thread the LLM clients through so the style playground endpoint can
    // run dry-run completions. Other admin endpoints don't need this; the
    // playground returns 503 when rag is undefined.
    ...(deps.rag
      ? {
          rag: {
            chat: deps.rag.chat,
            embedder: deps.rag.embedder,
            ...(deps.rag.topK !== undefined ? { topK: deps.rag.topK } : {}),
            ...(deps.rag.maxDistance !== undefined ? { maxDistance: deps.rag.maxDistance } : {}),
          },
        }
      : {}),
    onConversationChanged: (conversationId: number) => {
      deps.bus?.publish({ type: "conversation:updated", conversationId });
    },
    onMessageSent: ({ conversationId, tgUserId }: { conversationId: number; tgUserId: number }) => {
      deps.bus?.publish({ type: "message:new", conversationId, tgUserId });
    },
    leadsChatId: deps.leadsChatId ?? null,
    visaChatId: deps.visaChatId ?? null,
  };
  router.get("/admin/api/status", createStatusHandler(apiDeps));
  router.get("/admin/api/analytics", createAnalyticsHandler(apiDeps));
  router.get("/admin/api/users", createListUsersHandler(apiDeps));
  // Telegram file proxy — browsers hit this URL from <img>/<video> tags
  // in the admin chat view; admin session cookie is the auth.
  router.get("/admin/api/tg-files/:fileId", createDownloadFileHandler(apiDeps));
  router.patch("/admin/api/users/:id/memory", createUpdateUserMemoryHandler(apiDeps));
  // Detail view — register AFTER the more-specific :id/memory sub-path so
  // the literal sub-path matches first (router does linear scan).
  router.get("/admin/api/users/:id", createUserDetailHandler(apiDeps));
  router.get("/admin/api/conversations", createListConversationsHandler(apiDeps));
  // Conversation export — these MUST come before /admin/api/conversations/:id
  // because the ":id" pattern is `[^/]+` and would otherwise capture the
  // literal "export.jsonl" as `:id="export.jsonl"`. The router does linear
  // first-match scan: register specific routes ahead of greedy ones.
  router.get(
    "/admin/api/conversations/export.jsonl",
    createBulkExportConversationsHandler(apiDeps),
  );
  router.get("/admin/api/conversations/:id/export.jsonl", createExportConversationHandler(apiDeps));

  router.get("/admin/api/conversations/:id", createConversationDetailHandler(apiDeps));
  router.post("/admin/api/conversations/:id/take", createTakeHandler(apiDeps));
  router.post("/admin/api/conversations/:id/release", createReleaseHandler(apiDeps));
  router.post("/admin/api/conversations/:id/reply", createReplyHandler(apiDeps));
  router.delete("/admin/api/conversations/:id", createDeleteConversationHandler(apiDeps));

  // Sales-style engine endpoints (Phase 2b).
  router.get("/admin/api/styles", createListStylesHandler(apiDeps));
  router.post("/admin/api/styles", createCreateStyleHandler(apiDeps));
  router.get("/admin/api/styles/:id", createGetStyleHandler(apiDeps));
  router.patch("/admin/api/styles/:id", createEditStyleHandler(apiDeps));
  router.post("/admin/api/styles/:id/playground", createStylePlaygroundHandler(apiDeps));
  router.get("/admin/api/styles/:id/skills", createGetStyleSkillsHandler(apiDeps));
  router.put("/admin/api/styles/:id/skills", createSetStyleSkillsHandler(apiDeps));

  // Skill catalogue (read-only list + global enable/disable toggle).
  router.get("/admin/api/skills", createListSkillsHandler(apiDeps));
  // Specific path before :slug catch-all so "recommend" isn't captured as a slug.
  router.get("/admin/api/skills/recommend", createRecommendSkillsHandler(apiDeps));
  router.patch("/admin/api/skills/:slug", createUpdateSkillHandler(apiDeps));

  // Style ELO leaderboard (Phase 2 outcome attribution).
  router.get("/admin/api/style-ratings", createListStyleRatingsHandler(apiDeps));

  // Self-play match transcripts (Phase 3).
  router.get("/admin/api/self-play", createListSelfPlayMatchesHandler(apiDeps));
  router.get("/admin/api/self-play/:id", createGetSelfPlayMatchHandler(apiDeps));
  router.delete("/admin/api/self-play/:id", createDeleteSelfPlayMatchHandler(apiDeps));
  router.get("/admin/api/pairwise", createListPairwiseMatchesHandler(apiDeps));
  router.get("/admin/api/pairwise/:id", createGetPairwiseMatchHandler(apiDeps));
  router.delete("/admin/api/pairwise/:id", createDeletePairwiseMatchHandler(apiDeps));
  router.get("/admin/api/coach", createListCoachProposalsHandler(apiDeps));
  router.post("/admin/api/coach/run", createRunCoachHandler(apiDeps));
  router.get("/admin/api/coach/:id", createGetCoachProposalHandler(apiDeps));
  router.post("/admin/api/coach/:id/decide", createDecideCoachProposalHandler(apiDeps));
  router.post("/admin/api/coach/:id/apply", createApplyCoachProposalHandler(apiDeps));
  router.post("/admin/api/coach/:id/shadow-eval", createStartShadowEvalHandler(apiDeps));
  router.get("/admin/api/coach/:id/shadow-eval", createGetShadowEvalHandler(apiDeps));
  router.post("/admin/api/coach/:id/rollback", createRollbackCoachProposalHandler(apiDeps));
  router.delete("/admin/api/coach/:id", createDeleteCoachProposalHandler(apiDeps));
  router.get("/admin/api/experiments", createListExperimentsHandler(apiDeps));
  router.post("/admin/api/experiments", createCreateExperimentHandler(apiDeps));
  router.patch("/admin/api/experiments/:id", createSetExperimentStatusHandler(apiDeps));
  router.get("/admin/api/experiments/:id/funnel", createExperimentFunnelHandler(apiDeps));

  // Vacancies — admin-managed list of currently-open offers, prepended
  // to the RAG context on every turn.
  router.get("/admin/api/vacancies", createListVacanciesHandler(apiDeps));
  router.post("/admin/api/vacancies", createCreateVacancyHandler(apiDeps));
  router.patch("/admin/api/vacancies/:id", createUpdateVacancyHandler(apiDeps));
  router.delete("/admin/api/vacancies/:id", createDeleteVacancyHandler(apiDeps));

  // KB management — list/inspect/delete/re-tag indexed documents.
  router.get("/admin/api/kb/documents", createListKbDocumentsHandler(apiDeps));
  // Ingest must come BEFORE the :id detail/patch/delete paths — router does
  // linear first-match scan on a `[^/]+` pattern, so without this order the
  // literal "ingest" segment would be captured as `:id="ingest"`.
  router.post("/admin/api/kb/ingest", createIngestKbDocumentHandler(apiDeps));
  // Book upload: multipart PDF/TXT/MD → ingest with topic="books".
  router.post("/admin/api/kb/books/upload", createUploadBookHandler(apiDeps));
  router.get("/admin/api/kb/documents/:id", createGetKbDocumentHandler(apiDeps));
  router.patch("/admin/api/kb/documents/:id", createUpdateKbDocumentHandler(apiDeps));
  router.delete("/admin/api/kb/documents/:id", createDeleteKbDocumentHandler(apiDeps));

  // KB suggestions — unanswered questions queue with approval pipeline.
  // "counts" and the POST (create) must come before "/:id" so they're not
  // captured by the ":id" pattern.
  router.get("/admin/api/kb/suggestions/counts", createKbSuggestionCountsHandler(apiDeps));
  router.get("/admin/api/kb/suggestions", createListKbSuggestionsHandler(apiDeps));
  router.post("/admin/api/kb/suggestions", createCreateKbSuggestionHandler(apiDeps));
  router.post("/admin/api/kb/suggestions/:id/approve", createApproveKbSuggestionHandler(apiDeps));
  router.post("/admin/api/kb/suggestions/:id/reject", createRejectKbSuggestionHandler(apiDeps));
  router.patch("/admin/api/kb/suggestions/:id", createUpdateKbSuggestionHandler(apiDeps));
  router.get("/admin/api/kb/suggestions/:id", createGetKbSuggestionHandler(apiDeps));

  // Leads — pipeline state machine: intake → approve/reject → docs → submitted.
  router.get("/admin/api/leads", createListLeadsHandler(apiDeps));
  router.post("/admin/api/leads/from-conversation/:id", createPromoteLeadHandler(apiDeps));
  router.post("/admin/api/leads/:id/approve", createApproveLeadHandler(apiDeps));
  router.post("/admin/api/leads/:id/reject", createRejectLeadHandler(apiDeps));
  router.post("/admin/api/leads/:id/send-intake", createSendIntakeHandler(apiDeps));
  router.post("/admin/api/leads/:id/submit-to-visa", createSubmitToVisaHandler(apiDeps));
  // Notes — sub-resource of a lead. Register before the catch-all
  // `/leads/:id` so /:id/notes doesn't get captured as a literal id.
  router.post("/admin/api/leads/:id/notes", createCreateLeadNoteHandler(apiDeps));
  router.delete("/admin/api/leads/:id/notes/:noteId", createDeleteLeadNoteHandler(apiDeps));
  // Detail / patch routes — register AFTER all `/leads/:id/<action>`
  // sub-paths so the literal sub-path matches first (router does
  // linear first-match scanning).
  router.get("/admin/api/leads/:id", createLeadDetailHandler(apiDeps));
  router.patch("/admin/api/leads/:id/visa-docs", createUpdateVisaDocsHandler(apiDeps));
  router.delete("/admin/api/leads/:id", createDeleteLeadHandler(apiDeps));

  if (deps.enableTestHooks) {
    mountTestHooks(router, deps.sql);
  }

  return router;
}
