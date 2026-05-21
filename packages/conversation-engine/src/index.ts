export { resolveContact } from "./contact-resolver.ts";
export { resolveConversation } from "./conversation-resolver.ts";
export {
  ChannelIdentitiesRepo,
  type ChannelIdentityRow,
  ContactsRepo,
  type ContactRow,
  ConversationsRepo,
  type ConversationRow,
  type Db,
  DrizzleKbStore,
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
  type SkillAggregateRow,
  type SkillOutcomeRow,
  SkillOutcomesRepo,
  StylesRepo,
  type StyleRow,
} from "./dal/index.ts";
export {
  type AnalyzeLeadOpts,
  type AnalysisResult,
  CoachAnalyzer,
  type CoachAnalyzerOpts,
  extractUserAssistantPairs,
} from "./coach-analyzer.ts";
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
export {
  LlmMemoryExtractor,
  type MemoryExtractor,
  runMemoryExtraction,
} from "./memory-extractor.ts";
export {
  applyClassifiedStage,
  LlmStageClassifier,
  RegexStageClassifier,
  type StageClassifier,
} from "./stage-classifier.ts";
export {
  decryptSecret,
  encryptSecret,
  getDecryptedSecret,
  SecretCryptoError,
  setEncryptedSecret,
} from "./secrets.ts";
export { dispatchOutbound } from "./outbound-dispatch.ts";
export {
  processInbound,
  type ProcessInboundDeps,
  type ReplyStrategy,
} from "./process-inbound.ts";
export {
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
