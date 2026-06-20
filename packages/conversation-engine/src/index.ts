export {
  AdminInformer,
  type AdminInformerDeps,
  INFORMER_TOPICS,
  type InformerEvent,
  type InformerLevel,
  type InformerSeverity,
  type InformerTopic,
  isMuted,
  notificationEventToInformer,
  opsAlertToInformer,
  passesThreshold,
  topicEnabled,
} from "./admin-informer.ts";
export {
  operatorLabel,
  type PickedOperator,
  pickLeastBusyOperator,
} from "./assign-operator.ts";
export {
  type BotSettings,
  DEFAULT_BOT_SETTINGS,
  isWithinBotHours,
  matchStopWord,
  mergeBotSettings,
  parseBotSettings,
  serializeBotSettings,
} from "./bot-settings.ts";
export { compactConversation } from "./compact-conversation.ts";
export { resolveContact } from "./contact-resolver.ts";
export { resolveConversation } from "./conversation-resolver.ts";
export {
  type ConversationSummaryPayload,
  loadRollingConversationContext,
  messageRowsToChatHistory,
  parseConversationSummaryPayload,
  type RollingConversationContext,
  type RollingConversationSummaryOptions,
  renderConversationSummaryBlock,
} from "./conversation-summary.ts";
export {
  type CustomerOfferAccepted,
  type CustomerOfferDraft,
  CustomerOfferFlow,
  formatCustomerOrderContext,
  type RecordPaymentSuccessInput,
  type RecordPaymentSuccessResult,
  renderCustomerOffer,
  renderProviderConfirmation,
  type SendCustomerOfferInput,
  type SendCustomerOfferResult,
} from "./customer-offer-flow.ts";
export {
  ACTIVE_SERVICE_ORDER_STATUSES,
  type AdminNotificationRow,
  type AgentToolCallFeedbackInput,
  type AgentToolCallFeedbackLabel,
  type AgentToolCallFeedbackRow,
  type AgentToolCallInput,
  type AgentToolCallListOpts,
  type AgentToolCallRow,
  type AgentToolCallSource,
  AgentToolCallsRepo,
  assertProviderRequestTransition,
  assertServiceOrderTransition,
  ChannelIdentitiesRepo,
  type ChannelIdentityRow,
  type ContactRow,
  ContactsRepo,
  type ConversationRow,
  ConversationsRepo,
  canTransitionProviderRequest,
  canTransitionServiceOrder,
  type Db,
  DrizzleKbStore,
  type ExperimentAllocationEntry,
  type ExperimentRow,
  ExperimentsRepo,
  type InformerPrefs,
  KbSuggestionsRepo,
  type LeadRow,
  LeadsRepo,
  type MessageRow,
  MessagesRepo,
  type NewAdminNotification,
  type NotificationRule,
  NotificationsRepo,
  type OperatorSettings,
  type OrderEventActorType,
  type OrderEventRow,
  OutboundQueueRepo,
  type OutboundQueueRow,
  type OwnerSettings,
  PROVIDER_REQUEST_STATUSES,
  ProviderRelayRepo,
  type ProviderRequestRow,
  type ProviderRequestStatus,
  parseAllocation,
  type RepoCtx,
  ScopedKbStore,
  SERVICE_ORDER_STATUSES,
  type ServiceOrderRow,
  type ServiceOrderStatus,
  type SkillAggregateRow,
  type SkillOutcomeRow,
  SkillOutcomesRepo,
  type StyleRow,
  StylesRepo,
} from "./dal/index.ts";
export {
  type RunDeferredInboundPostProcessingDeps,
  runDeferredInboundPostProcessing,
} from "./deferred-post-processing.ts";
export {
  type GenerateReplyAndEnqueueDeps,
  type GenerateReplyResult,
  generateReplyAndEnqueue,
} from "./dispatch-reply.ts";
export {
  ANY_QUOTE_CURRENCY_MENTION_RE,
  KNOWN_QUOTE_CURRENCIES,
  QUOTE_CURRENCY,
  QUOTE_CURRENCY_CODES,
  type QuoteCurrency,
  resolveQuoteCurrency,
} from "./exchange-quote-currency.ts";
export { loadExperimentVariants } from "./experiment-router.ts";
export { type EnqueueFixedReplyDeps, enqueueFixedReply } from "./fixed-reply.ts";
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
  asSupportedLang,
  DEFAULT_LANG,
  detectScriptLang,
  effectiveLang,
  type Lang,
  type LangResolveInput,
  type LangResolveResult,
  mapChannelLangHint,
  resolveConversationLang,
  SUPPORTED_LANGS,
} from "./language.ts";
export {
  ensureLead,
  type LeadHookContext,
  transitionLeadState,
} from "./lead-lifecycle.ts";
export {
  LlmMemoryExtractor,
  type MemoryExtractor,
  runMemoryExtraction,
} from "./memory-extractor.ts";
export { type NotificationEvent, NotificationService } from "./notifications.ts";
export {
  buildOperatorActionCallbackData,
  isOperatorHandoffEvent,
  OPERATOR_ACTION_CALLBACK_PREFIX,
  OPERATOR_BOT_ACTIONS,
  type OperatorActionPayload,
  type OperatorBotAction,
  type OperatorConversationModeAction,
  parseOperatorActionCallbackData,
} from "./operator-bot-actions.ts";
export { OperatorBotHandler } from "./operator-bot-handler.ts";
export {
  type OpsAlert,
  type OpsAlertKind,
  OpsAlertRouter,
  type OpsAlertRouterDeps,
  type OpsAlertSink,
  type OpsEmailSender,
  type OpsSeverity,
  type OwnerContacts,
  ResendEmailSender,
  renderOpsEmailHtml,
  resolveOwnerContacts,
} from "./ops-alerts.ts";
export { dispatchOutbound } from "./outbound-dispatch.ts";
export {
  normalizeReplyStrategyResult,
  type ProcessInboundDeps,
  processInbound,
  type ReplyStrategy,
  type ReplyStrategyOutput,
  type ReplyStrategyResult,
  type TranscribeInboundVoiceDeps,
  transcribeInboundVoice,
} from "./process-inbound.ts";
export { buildTranslationSystemPrompt } from "./prompts/translation.ts";
export {
  type CreatePaymentIntentInput,
  type PaymentLedgerResult,
  ProviderPaymentLedger,
  type RecordPaymentWebhookInput,
  type ServiceOrderCommissionRow,
  type ServiceOrderCommissionStatus,
  type ServiceOrderPaymentRow,
  type ServiceOrderPaymentStatus,
} from "./provider-payment-ledger.ts";
export {
  normalizeMetricLabel,
  type ProviderRelayMetrics,
  providerRelayTenantLabels,
} from "./provider-relay-metrics.ts";
export {
  type ProviderChannelIdentity,
  ProviderRelayOrchestrator,
  type ProviderRelaySendProviderRequestInput,
  type ProviderRelaySendProviderRequestResult,
  type ProviderRelayStartFailureReason,
  type ProviderRelayStartInput,
  type ProviderRelayStartResult,
} from "./provider-relay-orchestrator.ts";
export {
  extractProviderResponseMediaParts,
  extractProviderResponseText,
  type ProviderResponseHandleResult,
  ProviderResponseHandler,
  type ProviderResponseHandlerInput,
  type ProviderResponseMediaPart,
  type ProviderResponseParse,
  parseProviderResponse,
} from "./provider-response-handler.ts";
export {
  type ProviderRouteCandidate,
  ProviderRouter,
  type ProviderRoutingFailureReason,
  type ProviderRoutingInput,
  type ProviderRoutingResult,
} from "./provider-routing.ts";
export {
  type DueConversation,
  type GenerateReplyForConversationDeps,
  generateReplyForConversation,
} from "./reply-debounce.ts";
export {
  EXCHANGE_KYC_FALLBACK,
  EXCHANGE_PAYMENT_FALLBACK,
  EXCHANGE_PAYOUT_FALLBACK,
  EXCHANGE_SAFE_FALLBACK,
  type ExchangeOrderPolicyState,
  type ExchangePolicyGuardInput,
  type ExchangePolicyGuardReason,
  type ExchangePolicyGuardResult,
  type ExchangePolicyState,
  type ExchangeReplyGuardInput,
  type ExchangeReplyGuardReason,
  type ExchangeReplyGuardResult,
  type ExchangeResponseGuardAction,
  type ExchangeResponseGuardFinding,
  type ExchangeResponseGuardResult,
  type ExchangeVerificationPolicyState,
  exchangeGuardFindingFromResult,
  guardExchangePolicy,
  guardExchangeReply,
  LlmReplyStrategy,
  type LlmReplyStrategyOpts,
  parseStyleConfig,
  RagReplyStrategy,
  type RagReplyStrategyOpts,
  type RagTurnContext,
  type RagTurnInput,
  type ResolvedStyleAssignment,
} from "./reply-strategy/index.ts";
export { checkRlsEnforcement, type RlsRoleCheck } from "./rls-guard.ts";
export {
  decryptSecret,
  encryptSecret,
  getDecryptedSecret,
  SecretCryptoError,
  setEncryptedSecret,
} from "./secrets.ts";
// Stage-classifier impls (RegexStageClassifier, LlmStageClassifier) переехали
// в @chatman-media/sales — это sales-domain heuristics. Conv-engine оставляет
// только pipeline contract (StageClassifier interface) + persistence helper.
export { applyClassifiedStage, type StageClassifier } from "./stage-classifier.ts";
export {
  EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
  PROVIDER_RELAY_FEATURE_KEY,
  TenantFeatureFlagRepo,
  type TenantFeatureFlagRow,
  type TenantFeatureKey,
} from "./tenant-feature-flags.ts";
export type { ITranscriber } from "./transcriber.ts";
export { needsTranslation, OPERATOR_LANG, translateText } from "./translation.ts";
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
