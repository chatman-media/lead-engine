/**
 * Sales-style engine — typed schema for conversational personas.
 *
 * A `Style` bundles persona + voice + sales framework + Cialdini hooks +
 * per-stage instructions + few-shot examples + guardrails + model pin.
 * Styles are the unit of A/B testing in the sales engine: hold three of the
 * four orthogonal concerns constant (persona, framework, hooks, stage) and
 * rotate one to compare conversion outcomes.
 *
 * Imported into `tg-chatbot` from the sister `sales-guru` repo, where the
 * engine was prototyped without touching production code. See
 * `docs/SALES_STYLES.md` for the integration plan and design rationale.
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
  /** Fixed personal facts — see `Persona.facts` in `src/rag/answer.ts` for key semantics. */
  facts: z.record(z.string(), z.string()).optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const StyleSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
  displayName: z.string().min(1),
  persona: PersonaSchema,
  voice: z.object({
    tone: z.string().min(1),
    language: z.enum(["ru", "en"]).default("ru"),
    forbid: z.array(z.string()).default([]),
    /** Custom CTA reply sent after STALL_LIMIT consecutive NO_CONTEXT turns.
     *  Defaults to a generic "let's call" message when not set. */
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
    /** Ollama model tag, e.g. "qwen3:latest", or any string the provider accepts. */
    id: z.string().default("qwen3:latest"),
    temperature: z.number().min(0).max(2).default(0.8),
    /** Hard cap on reply tokens — provider-specific (Ollama: num_predict). */
    maxTokens: z.number().int().positive().default(256),
  }),
});
export type Style = z.infer<typeof StyleSchema>;
