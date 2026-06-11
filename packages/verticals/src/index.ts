export { defaultRegistry, VerticalRegistry } from "./registry.ts";
export {
  ANY_QUOTE_CURRENCY_MENTION_RE,
  KNOWN_QUOTE_CURRENCIES,
  QUOTE_CURRENCY,
  QUOTE_CURRENCY_CODES,
  type QuoteCurrency,
  resolveQuoteCurrency,
} from "./quote-currency.ts";
export {
  ACTIVE_PHASES,
  buildSkeletonFunnel,
  deriveDefaultPhase,
  effectivePhase,
  FUNNEL_PHASES,
  isActivePhase,
  KIND_TO_ANCHOR_PHASE,
  PHASE_ORDER,
  REQUIRED_ACTIVE_PHASES,
  validateBackbone,
} from "./phases.ts";
export type {
  ActivePhase,
  BackboneViolations,
  FunnelPhase,
  PhaseStageLike,
  SkeletonOptions,
  SkeletonStage,
} from "./phases.ts";
export type {
  FunnelStageDef,
  FunnelStageKind,
  QuestionnaireField,
  QuestionnaireFieldKind,
  QuestionnaireSchema,
  VerticalHooks,
  VerticalKbDocSeed,
  VerticalStyleSeed,
  VerticalTemplate,
} from "./types.ts";
