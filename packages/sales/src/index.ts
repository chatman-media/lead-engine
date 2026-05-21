// ─── Core types ─────────────────────────────────────────────────────────────

// NB: A/B routing (pickVariant) удалён — production использует
// `ABRouter` class из `@chatman-media/kb` через apps/api/llm-bootstrap.ts.
// Если sales-engine'у когда-то понадобится свой picker (например для
// self-play match'ей) — добавится отдельный модуль; пока избегаем 3-й
// независимой имплементации.

// ─── Coach ───────────────────────────────────────────────────────────────────
// `proposeStyleEdits` (coach.ts) — LLM coach который читает worst self-play
// transcripts и предлагает edits для Style spec'а. Out-of-band, admin-trigger.
// `CoachAnalyzer` (coach-analyzer.ts) — post-hoc grader, который для
// closed-lead'ов проходит transcript и записывает skill_outcomes (через
// gradeSkills из kb). Запускается отдельным admin-cron'ом — см.
// apps/api/scripts/coach-batch.ts.
export {
  type AnalyzeLeadOpts,
  type AnalysisResult,
  CoachAnalyzer,
  type CoachAnalyzerOpts,
  extractUserAssistantPairs,
} from "./coach-analyzer.ts";
export {
  applyEditsToStyle,
  type CoachInput,
  type CoachProposal,
  parseProposal,
  proposeStyleEdits,
} from "./coach.ts";
// ─── ELO rating ──────────────────────────────────────────────────────────────
export {
  actualScore,
  ELO_BASELINE,
  ELO_DEFAULT_K,
  type EloOutcome,
  eloUpdate,
  eloUpdatePair,
  expectedScore,
} from "./elo.ts";
// ─── Model registry ──────────────────────────────────────────────────────────
export {
  DEFAULT_MODEL_ID,
  getModelInfo,
  listModels,
  listModelsByProvider,
  MODELS,
  type ModelInfo,
} from "./models.ts";
// ─── Prompt composition ──────────────────────────────────────────────────────
export {
  type ComposeOptions,
  composeSystemPrompt,
  type SkillForPrompt,
} from "./prompt.ts";
export {
  type JudgeInput,
  type JudgeVerdict,
  judgeMatch,
  parseVerdict,
} from "./self-play/judge.ts";
export {
  _testCandidateConcluded,
  persistSelfPlayMatch,
  runSelfPlayMatch,
  type SelfPlayDeps,
  type SelfPlayMatchInput,
  type SelfPlayMatchResult,
} from "./self-play/orchestrator.ts";
export {
  judgePairwise,
  type PairwiseDeps,
  type PairwiseInput,
  type PairwiseMatchResult,
  type PairwiseVerdict,
  type PairwiseWinner,
  parsePairwiseVerdict,
  runPairwiseMatch,
} from "./self-play/pairwise.ts";
// ─── Self-play ───────────────────────────────────────────────────────────────
export {
  CANDIDATE_BY_SLUG,
  CANDIDATE_PERSONAS,
  type CandidatePersona,
} from "./self-play/personas.ts";
// ─── Shadow eval ─────────────────────────────────────────────────────────────
export {
  runShadowEval,
  type ShadowEvalDeps,
  type ShadowEvalInput,
  shadowDecide,
} from "./shadow-eval.ts";
// ─── Skill recommendations ───────────────────────────────────────────────────
export {
  type RecommendOptions,
  rankSkillRecommendations,
  type SkillRecommendation,
  wilsonLowerBound,
} from "./skill-recommendations.ts";
// ─── Skills catalogue ────────────────────────────────────────────────────────
export {
  SKILL_BY_SLUG,
  SKILL_CATALOGUE,
  SKILL_FAMILIES,
  SKILL_INTENTS,
  SKILL_SLUGS,
  type Skill,
  type SkillFamily,
  type SkillIntent,
  SkillSchema,
} from "./skills/catalogue.ts";
export {
  type ClassifyInput,
  type ClassifyResult,
  classifyStage,
  parseClassifierOutput,
  type StageSource,
} from "./stage-classifier.ts";
// ─── Stage routing ───────────────────────────────────────────────────────────
export { nextStage, type StageInput } from "./stage-router.ts";
// ─── Storage interfaces ──────────────────────────────────────────────────────
export type {
  IConversationsRepo,
  ILeadsRepo,
  IPairwiseMatchesRepo,
  ISelfPlayMatchesRepo,
  IShadowEvaluationsRepo,
  ISkillOutcomesRepo,
  ISkillsRepo,
  IStyleRatingsRepo,
  IUsersRepo,
  SelfPlayMatchRecord,
  SelfPlayMatchSummary,
  SelfPlayTurn,
  SkillAggregate,
  SkillRow,
} from "./store.ts";
// ─── Built-in styles ─────────────────────────────────────────────────────────
export { getStyle, getStyleOrThrow, listStyles } from "./styles/index.ts";
export {
  FUNNEL_STAGES,
  type FunnelStage,
  HOOK_KINDS,
  type Hook,
  type HookKind,
  HookSchema,
  type Persona,
  PersonaSchema,
  SALES_FRAMEWORKS,
  type SalesFramework,
  type StageConfig,
  StageConfigSchema,
  type Style,
  StyleSchema,
} from "./types.ts";
