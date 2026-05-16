// Admin REST API — barrel re-export over decomposed `routes/*` modules.
//
// Each handler now lives in a per-resource file under `src/admin/routes/`.
// This file exists for backwards compatibility with callers that import from
// `./admin/api.ts` — primarily `src/app.ts` (route registration) and a few
// tests. New code should import directly from the resource module.

export { createAnalyticsHandler } from "./routes/analytics.ts";
export {
  createApplyCoachProposalHandler,
  createDecideCoachProposalHandler,
  createDeleteCoachProposalHandler,
  createGetCoachProposalHandler,
  createListCoachProposalsHandler,
  createRollbackCoachProposalHandler,
  createRunCoachHandler,
} from "./routes/coach.ts";
export {
  createConversationDetailHandler,
  createDeleteConversationHandler,
  createListConversationsHandler,
  createReleaseHandler,
  createReplyHandler,
  createTakeHandler,
  createUpdateUserMemoryHandler,
} from "./routes/conversations.ts";
export {
  createCreateExperimentHandler,
  createExperimentFunnelHandler,
  createListExperimentsHandler,
  createSetExperimentStatusHandler,
} from "./routes/experiments.ts";
export {
  createBulkExportConversationsHandler,
  createExportConversationHandler,
} from "./routes/export.ts";
export { createDownloadFileHandler, createMediaFileHandler } from "./routes/files.ts";
export {
  createDeleteKbDocumentHandler,
  createGetKbDocumentHandler,
  createIngestKbDocumentHandler,
  createListKbDocumentsHandler,
  createUpdateKbDocumentHandler,
} from "./routes/kb-documents.ts";
export {
  createApproveKbSuggestionHandler,
  createCreateKbSuggestionHandler,
  createGetKbSuggestionHandler,
  createKbSuggestionCountsHandler,
  createListKbSuggestionsHandler,
  createRejectKbSuggestionHandler,
  createUpdateKbSuggestionHandler,
} from "./routes/kb-suggestions.ts";
export {
  createApproveLeadHandler,
  createCreateLeadNoteHandler,
  createDeleteLeadHandler,
  createDeleteLeadNoteHandler,
  createLeadCallbackHandler,
  createLeadDetailHandler,
  createListLeadsHandler,
  createPromoteLeadHandler,
  createRejectLeadHandler,
  createSendIntakeHandler,
  createSubmitToVisaHandler,
  createUpdateVisaDocsHandler,
} from "./routes/leads.ts";
export { createUploadBookHandler } from "./routes/library.ts";
export {
  createClearUserbotProxyStatusesHandler,
  createDeleteTelegramWebhookHandler,
  createGetTelegramWebhookHandler,
  createKbIngestHandler,
  createKbWipeHandler,
  createListUserbotProxiesHandler,
  createPurgeOutcomesHandler,
  createReplaceUserbotProxiesHandler,
  createReseedVacanciesHandler,
  createSetTelegramWebhookHandler,
  createUserbotQueueStatsHandler,
} from "./routes/ops.ts";
export {
  createDeletePairwiseMatchHandler,
  createGetPairwiseMatchHandler,
  createListPairwiseMatchesHandler,
} from "./routes/pairwise.ts";
export {
  createDeleteSelfPlayMatchHandler,
  createGetSelfPlayMatchHandler,
  createListSelfPlayMatchesHandler,
} from "./routes/self-play.ts";
export {
  createGetShadowEvalHandler,
  createStartShadowEvalHandler,
} from "./routes/shadow-eval.ts";
export {
  createGetStyleSkillsHandler,
  createListSkillsHandler,
  createListStyleRatingsHandler,
  createRecommendSkillsHandler,
  createSetStyleSkillsHandler,
  createUpdateSkillHandler,
} from "./routes/skills.ts";
export { createStatusHandler } from "./routes/status.ts";
export {
  createCreateStyleHandler,
  createDeleteStyleHandler,
  createEditStyleHandler,
  createGetStyleHandler,
  createListStylesHandler,
  createStylePlaygroundHandler,
} from "./routes/styles.ts";
export {
  createDeleteUserDataHandler,
  createListUsersHandler,
  createUserDetailHandler,
} from "./routes/users.ts";
export {
  createCreateVacancyHandler,
  createDeleteVacancyHandler,
  createListVacanciesHandler,
  createUpdateVacancyHandler,
} from "./routes/vacancies.ts";
export type { AdminApiDeps } from "./shared.ts";
export { __resetBotHealthCacheForTesting } from "./shared.ts";
