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
  /** Stages where this skill applies. Empty = always applicable. */
  applicableStages: readonly FunnelStage[];
}

export interface ComposeOptions {
  includeFewShot?: boolean;
  userFacts?: Record<string, string>;
  conversationSummary?: string;
  skills?: readonly SkillForPrompt[];
}
