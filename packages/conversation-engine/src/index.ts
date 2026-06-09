export { resolveContact } from "./contact-resolver.ts";
export { resolveConversation } from "./conversation-resolver.ts";
export {
  ChannelIdentitiesRepo,
  type ChannelIdentityRow,
  type AgentToolCallFeedbackInput,
  type AgentToolCallFeedbackLabel,
  type AgentToolCallFeedbackRow,
  type AgentToolCallInput,
  type AgentToolCallListOpts,
  type AgentToolCallRow,
  type AgentToolCallSource,
  AgentToolCallsRepo,
  ContactsRepo,
  type ContactRow,
  ConversationsRepo,
  type ConversationRow,
  type Db,
  DrizzleKbStore,
  KbSuggestionsRepo,
  type ExperimentAllocationEntry,
  ExperimentsRepo,
  type ExperimentRow,
  LeadsRepo,
  type LeadRow,
  MessagesRepo,
  type MessageRow,
  OutboundQueueRepo,
  type OutboundQueueRow,
  parseAllocation,
  type RepoCtx,
  ScopedKbStore,
  type SkillAggregateRow,
  type SkillOutcomeRow,
  SkillOutcomesRepo,
  StylesRepo,
  type StyleRow,
  type AdminNotificationRow,
  type InformerPrefs,
  type NewAdminNotification,
  NotificationsRepo,
  type NotificationRule,
  type OperatorSettings,
  type OwnerSettings,
} from "./dal/index.ts";
export { NotificationService, type NotificationEvent } from "./notifications.ts";
export {
  type OpsAlert,
  type OpsAlertKind,
  type OpsAlertRouterDeps,
  type OpsAlertSink,
  type OpsEmailSender,
  OpsAlertRouter,
  type OpsSeverity,
  type OwnerContacts,
  renderOpsEmailHtml,
  ResendEmailSender,
  resolveOwnerContacts,
} from "./ops-alerts.ts";
export {
  AdminInformer,
  type AdminInformerDeps,
  type InformerEvent,
  type InformerLevel,
  type InformerSeverity,
  type InformerTopic,
  INFORMER_TOPICS,
  isMuted,
  notificationEventToInformer,
  opsAlertToInformer,
  passesThreshold,
  topicEnabled,
} from "./admin-informer.ts";
export { OperatorBotHandler } from "./operator-bot-handler.ts";
// CoachAnalyzer переехал в @chatman-media/sales (sales-domain code).
// Back-compat re-export невозможен — создал бы circular dep (sales импортит
// conv-engine для DAL-типов). Consumer'ы должны импортировать напрямую
// из `@chatman-media/sales`. См. apps/api/scripts/coach-batch.ts.
export {
  allowedTransitions,
  FunnelTransitionError,
  getInitialStage,
  isTerminal,
  validateTransition,
} from "./funnel-machine.ts";
export {
  ensureLead,
  type LeadHookContext,
  transitionLeadState,
} from "./lead-lifecycle.ts";
export { loadExperimentVariants } from "./experiment-router.ts";
export { compactConversation } from "./compact-conversation.ts";
export {
  LlmMemoryExtractor,
  type MemoryExtractor,
  runMemoryExtraction,
} from "./memory-extractor.ts";
// Stage-classifier impls (RegexStageClassifier, LlmStageClassifier) переехали
// в @chatman-media/sales — это sales-domain heuristics. Conv-engine оставляет
// только pipeline contract (StageClassifier interface) + persistence helper.
export { applyClassifiedStage, type StageClassifier } from "./stage-classifier.ts";
export {
  decryptSecret,
  encryptSecret,
  getDecryptedSecret,
  SecretCryptoError,
  setEncryptedSecret,
} from "./secrets.ts";
export {
  generateReplyAndEnqueue,
  type GenerateReplyAndEnqueueDeps,
  type GenerateReplyResult,
} from "./dispatch-reply.ts";
export {
  runDeferredInboundPostProcessing,
  type RunDeferredInboundPostProcessingDeps,
} from "./deferred-post-processing.ts";
export { dispatchOutbound } from "./outbound-dispatch.ts";
export {
  processInbound,
  type ProcessInboundDeps,
  type ReplyStrategy,
  transcribeInboundVoice,
  type TranscribeInboundVoiceDeps,
} from "./process-inbound.ts";
export type { ITranscriber } from "./transcriber.ts";
export {
  EXCHANGE_SAFE_FALLBACK,
  guardExchangeReply,
  type ExchangeReplyGuardInput,
  type ExchangeReplyGuardResult,
  LlmReplyStrategy,
  type LlmReplyStrategyOpts,
  parseStyleConfig,
  RagReplyStrategy,
  type RagReplyStrategyOpts,
} from "./reply-strategy/index.ts";
export {
  type ChannelContext,
  type Clock,
  type PipelineEvent,
  type PipelineSink,
  type ProcessInboundResult,
  systemClock,
  type TenantContext,
} from "./types.ts";
export { withTenant } from "./with-tenant.ts";
export { checkRlsEnforcement, type RlsRoleCheck } from "./rls-guard.ts";
