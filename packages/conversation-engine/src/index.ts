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
  ACTIVE_SERVICE_ORDER_STATUSES,
  assertProviderRequestTransition,
  assertServiceOrderTransition,
  ContactsRepo,
  type ContactRow,
  ConversationsRepo,
  type ConversationRow,
  canTransitionProviderRequest,
  canTransitionServiceOrder,
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
  type OrderEventActorType,
  type OrderEventRow,
  PROVIDER_REQUEST_STATUSES,
  ProviderRelayRepo,
  type ProviderRequestRow,
  type ProviderRequestStatus,
  parseAllocation,
  type RepoCtx,
  SERVICE_ORDER_STATUSES,
  ScopedKbStore,
  type ServiceOrderRow,
  type ServiceOrderStatus,
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
export {
  buildOperatorActionCallbackData,
  isOperatorHandoffEvent,
  OPERATOR_ACTION_CALLBACK_PREFIX,
  OPERATOR_BOT_ACTIONS,
  parseOperatorActionCallbackData,
  type OperatorActionPayload,
  type OperatorBotAction,
  type OperatorConversationModeAction,
} from "./operator-bot-actions.ts";
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
  normalizeMetricLabel,
  type ProviderRelayMetrics,
  providerRelayTenantLabels,
} from "./provider-relay-metrics.ts";
export {
  type ProviderChannelIdentity,
  ProviderRelayOrchestrator,
  type ProviderRelayStartFailureReason,
  type ProviderRelayStartInput,
  type ProviderRelayStartResult,
  type ProviderRelaySendProviderRequestInput,
  type ProviderRelaySendProviderRequestResult,
} from "./provider-relay-orchestrator.ts";
export {
  EXCHANGE_RESPONSE_GUARD_FEATURE_KEY,
  PROVIDER_RELAY_FEATURE_KEY,
  TenantFeatureFlagRepo,
  type TenantFeatureFlagRow,
  type TenantFeatureKey,
} from "./tenant-feature-flags.ts";
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
  EXCHANGE_KYC_FALLBACK,
  EXCHANGE_PAYMENT_FALLBACK,
  EXCHANGE_PAYOUT_FALLBACK,
  EXCHANGE_SAFE_FALLBACK,
  exchangeGuardFindingFromResult,
  guardExchangePolicy,
  guardExchangeReply,
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
  LlmReplyStrategy,
  type LlmReplyStrategyOpts,
  parseStyleConfig,
  RagReplyStrategy,
  type RagReplyStrategyOpts,
  type RagTurnContext,
  type RagTurnInput,
  type ResolvedStyleAssignment,
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
export {
  ANY_QUOTE_CURRENCY_MENTION_RE,
  KNOWN_QUOTE_CURRENCIES,
  QUOTE_CURRENCY,
  QUOTE_CURRENCY_CODES,
  type QuoteCurrency,
  resolveQuoteCurrency,
} from "./exchange-quote-currency.ts";
