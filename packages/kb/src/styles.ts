/**
 * Sales-style engine — typed schema for conversational personas.
 *
 * A `Style` bundles persona + voice + sales framework + Cialdini hooks +
 * per-stage instructions + few-shot examples + guardrails + model pin.
 * Styles are the unit of A/B testing in the sales engine: hold three of the
 * four orthogonal concerns constant (persona, framework, hooks, stage) and
 * rotate one to compare conversion outcomes.
 */
import { z } from "zod";

export const FUNNEL_STAGES = ["opener", "qualify", "pitch", "objection", "close"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const SALES_FRAMEWORKS = ["AIDA", "PAS", "SPIN", "NEPQ", "straight_line"] as const;
export type SalesFramework = (typeof SALES_FRAMEWORKS)[number];

export const HOOK_KINDS = [
  "social_proof",
  "scarcity",
  "authority",
  "liking",
  "reciprocity",
  "commitment",
] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

export const HookSchema = z.object({
  kind: z.enum(HOOK_KINDS),
  text: z.string().min(1),
});
export type Hook = z.infer<typeof HookSchema>;

export const StageConfigSchema = z.object({
  goal: z.string().min(1),
  guidance: z.string().optional(),
  groundingRequired: z.boolean().default(false),
  maxTurns: z.number().int().positive().optional(),
});
export type StageConfig = z.infer<typeof StageConfigSchema>;

export const PersonaSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["human", "assistant"]),
  company: z.string().optional(),
  facts: z.record(z.string(), z.string()).optional(),
});
export type StylePersona = z.infer<typeof PersonaSchema>;

export const StyleSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
  displayName: z.string().min(1),
  persona: PersonaSchema,
  voice: z.object({
    tone: z.string().min(1),
    language: z.enum(["ru", "en"]).default("ru"),
    forbid: z.array(z.string()).default([]),
    stallCtaReply: z.string().optional(),
  }),
  framework: z.enum(SALES_FRAMEWORKS),
  hooks: z.array(HookSchema).default([]),
  stages: z.object({
    opener: StageConfigSchema.optional(),
    qualify: StageConfigSchema.optional(),
    pitch: StageConfigSchema.optional(),
    objection: StageConfigSchema.optional(),
    close: StageConfigSchema.optional(),
  }),
  fewShot: z
    .array(
      z.object({
        user: z.string(),
        assistant: z.string(),
        stage: z.enum(FUNNEL_STAGES).optional(),
      }),
    )
    .default([]),
  guardrails: z.object({
    noMinors: z.boolean().default(true),
    botDisclosureOnDirectQuestion: z.boolean().default(true),
    forbiddenTopics: z.array(z.string()).default([]),
  }),
  model: z.object({
    id: z.string().default("qwen3:latest"),
    temperature: z.number().min(0).max(2).default(0.8),
    maxTokens: z.number().int().positive().default(256),
  }),
});
export type Style = z.infer<typeof StyleSchema>;

/**
 * A persuasion skill in the shape `composeSystemPrompt` consumes.
 * Decoupled from DB row shape so the prompt module stays pure.
 */
export interface SkillForPrompt {
  slug: string;
  displayName: string;
  promptFragment: string;
  /**
   * Stages where this skill applies. Empty array = always applicable.
   * May contain FunnelStage names ("qualify", "pitch"…) or stage-kind
   * strings ("intake", "active") — `composeSystemPrompt` does string
   * comparison against the current stage/kind value so both work.
   */
  applicableStages: readonly string[];
}

/**
 * A director-level persuasion hook — tenant-specific scripted mini-technique.
 * Unlike universal skills (from the catalogue), hooks are always injected for
 * this tenant regardless of which style or stage is active.
 */
export interface DirectorHookForPrompt {
  name: string;
  body: string;
  /** Optional natural-language hint for when to apply this hook. */
  triggerHint?: string | null;
}

export interface ComposeOptions {
  includeFewShot?: boolean;
  userFacts?: Record<string, string>;
  conversationSummary?: string;
  skills?: readonly SkillForPrompt[];
  /**
   * Tenant-specific persuasion scripts added by the director. Injected as a
   * "ХУКИ УБЕЖДЕНИЯ" block BEFORE the universal skills block. Always active —
   * not filtered by stage or style.
   */
  directorHooks?: readonly DirectorHookForPrompt[];
  /**
   * Support mode — set when the lead is past the sales stage and waiting on a
   * downstream process. When set, the prompt drops the sales framework / hooks
   * / skills / few-shot / funnel-stage guidance and uses a calm FAQ-support
   * block instead. `docs` = collecting their documents, `submitted` = filed.
   */
  supportPhase?: "docs" | "submitted";
  /**
   * Per-stage override (Phase 2): goal/guidance from the lead's current funnel
   * stage_definition. Takes precedence over `style.stages[stage]` for the stage
   * block. Lets AI-built funnels carry per-stage instructions.
   */
  stageOverride?: { goal: string; guidance?: string };
  /**
   * Динамический контекст текущего запроса гостя (multi-request / concierge):
   * какой тип запроса ведётся + сколько открыто. Инжектится блоком «ЗАПРОС
   * ГОСТЯ». null/absent для линейных вертикалей.
   */
  requestContext?: string;
  /**
   * Лид стоит на стадии awaiting_operator (R5): цену/условия даёт человек-оператор.
   * Бот придерживает гостя и не выдумывает детали. Блок «ОЖИДАНИЕ ОПЕРАТОРА».
   */
  awaitingOperator?: boolean;
  /**
   * Инлайнить ли KB-контекст в системный промпт (дефолт true). false → блок KB
   * CONTEXT НЕ добавляется в системный промпт; вызывающий (answer.ts) выносит его
   * отдельным сообщением после истории, чтобы префикс system+history кешировался
   * провайдером. Логика grounding не меняется — она смотрит на присутствие
   * preFetchedKbContext, а не на способ его подачи.
   */
  inlineKbContext?: boolean;
}
