import { extractJsonObject } from "./llm-json.ts";
import type { ISelfPlayMatchesRepo } from "./store.ts";
/**
 * Coach-LLM: reads recent self-play LOSSES and DRAWS for a style,
 * inspects what failed, proposes concrete edits to the style spec.
 *
 * Produces a STRUCTURED proposal (JSON) — never auto-applies. The
 * operator reviews the proposal, accepts or discards. Fields the coach
 * can suggest:
 *   - persona.name / company / facts (rare — usually stable)
 *   - voice.tone tweaks (e.g. "warmer at qualify")
 *   - voice.forbid additions (specific phrases that triggered objections)
 *   - hooks add/remove
 *   - stages.X.guidance (per-stage instructions)
 *   - fewShot additions (concrete reply patterns that worked elsewhere)
 *   - skills (slugs to attach / detach)
 *
 * The coach receives:
 *   - the current style.json
 *   - 5-10 worst transcripts (judge_reason + full conversation)
 *   - the candidate persona summaries (so it knows what archetypes the
 *     style is losing to)
 *
 * Cost: 1 LLM call per coach run. Run weekly or on-demand, not per match.
 */

import type { ChatClient, ChatMessage } from "@chatman-media/rag";
import {
  CANDIDATE_PERSONAS,
  type CandidatePersona,
} from "./self-play/personas.ts";
import type { Style } from "./types.ts";

export interface CoachProposal {
  /** Short summary of what the coach observed across the losses. */
  summary: string;
  /** Concrete edits to apply. Each field is optional; absent = no change. */
  edits: {
    voice_tone?: string;
    voice_forbid_add?: string[];
    hooks_add?: Array<{ kind: string; text: string }>;
    stage_guidance?: Partial<{
      opener: string;
      qualify: string;
      pitch: string;
      objection: string;
      close: string;
    }>;
    fewshot_add?: Array<{ user: string; assistant: string; stage?: string }>;
    skills_attach?: string[];
    skills_detach?: string[];
  };
  /** Per-edit rationale — operator-facing, explains WHY each change. */
  rationale: string[];
  /** Raw model output when JSON parsing failed (debugging). */
  raw?: string;
}

export interface CoachInput {
  style: Style;
  matchesRepo: ISelfPlayMatchesRepo;
  chat: ChatClient;
  /** How many recent lost+draw matches to include. Default 8. */
  sampleSize?: number;
  /** When set, only includes matches with this persona slug. */
  personaSlug?: string;
  /** Currently-attached skill slugs (to inform attach/detach suggestions). */
  currentSkills?: readonly string[];
  /** Override the model id (e.g. use a stronger model than the bot's). */
  model?: string;
}

const PERSONA_LOOKUP = new Map<string, CandidatePersona>(
  CANDIDATE_PERSONAS.map((p) => [p.slug, p]),
);

const COACH_SYSTEM = `You are a sales coach analyzing failed conversations between an agency salesperson (recruiter for foreign work contracts) and simulated candidate personas. Your job: given the current "style" spec and a sample of LOST or DRAW transcripts, propose specific, actionable edits to improve win rate.

Be SPECIFIC. Vague advice ("be more empathetic") is useless. Quote the moment in the transcript that decided the loss, then suggest the exact phrase / hook / guidance that would have changed it.

Be CONSERVATIVE. Don't suggest a complete rewrite. Pick 1-3 highest-leverage changes. Each change must point to a concrete observation in the transcripts.

VALID skill slugs you can suggest in skills_attach / skills_detach (subset only — don't invent):
  cialdini family: social-proof-stat, scarcity-spots-left, authority-license, liking-genuine-compliment, reciprocity-free-info, commitment-microyes, unity-belonging
  voss family: mirroring, tactical-empathy, accusation-audit, calibrated-question, late-night-fm, that's-right
  nlp family: future-pacing, sensory-language, presupposition, embedded-command
  sales family: assumptive-close, alternative-close, fear-of-loss, social-proof-numbers
  custom family: specific-next-step, micro-commitment, pattern-interrupt

OUTPUT FORMAT — RETURN EXACTLY THIS JSON, NOTHING ELSE:
{
  "summary": "<2-3 sentence diagnosis of the failure pattern>",
  "edits": {
    "voice_tone": "<replacement string, omit if no change>",
    "voice_forbid_add": ["<phrase>", ...],
    "hooks_add": [{"kind":"social_proof|scarcity|authority|liking|reciprocity|commitment", "text":"..."}],
    "stage_guidance": {"opener":"...", "qualify":"...", "pitch":"...", "objection":"...", "close":"..."},
    "fewshot_add": [{"user":"...", "assistant":"...", "stage":"opener|qualify|pitch|objection|close"}],
    "skills_attach": ["<slug>", ...],
    "skills_detach": ["<slug>", ...]
  },
  "rationale": ["<one sentence per edit pointing to a specific transcript moment>", ...]
}

Omit any "edits" sub-key when there's no change for it. Empty edits object = no actionable signal.

No markdown, no code fences, no commentary outside the JSON.`;

function transcriptToText(
  t: Array<{ role: "candidate" | "salesperson"; text: string }>,
): string {
  return t
    .map(
      (m, i) =>
        `[${i + 1}] ${m.role === "candidate" ? "candidate" : "salesperson"}: ${m.text}`,
    )
    .join("\n");
}

export async function proposeStyleEdits(
  input: CoachInput,
): Promise<CoachProposal> {
  const sampleSize = input.sampleSize ?? 8;

  // Pull losses first, then draws to fill the sample. Wins are uninformative
  // for coaching — we only learn from failure.
  const lossOpts: Parameters<typeof input.matchesRepo.list>[0] = {
    styleSlug: input.style.slug,
    outcome: "lost",
    limit: sampleSize,
    ...(input.personaSlug ? { personaSlug: input.personaSlug } : {}),
  };
  const losses = await input.matchesRepo.list(lossOpts);
  const remaining = sampleSize - losses.length;
  const draws =
    remaining > 0
      ? await input.matchesRepo.list({
          styleSlug: input.style.slug,
          outcome: "draw",
          limit: remaining,
          ...(input.personaSlug ? { personaSlug: input.personaSlug } : {}),
        })
      : [];

  const sample = [...losses, ...draws];
  if (sample.length === 0) {
    return {
      summary:
        "No lost or draw matches found for this style — nothing to coach on.",
      edits: {},
      rationale: [],
    };
  }

  // Hydrate transcripts (list returns summaries without text).
  const fullMatches = (
    await Promise.all(sample.map((s) => input.matchesRepo.byId(s.id)))
  ).filter((m): m is NonNullable<typeof m> => m !== null);

  const transcriptsBlock = fullMatches
    .map((m) => {
      const persona = PERSONA_LOOKUP.get(m.persona_slug);
      return (
        `### Match #${m.id} — outcome: ${m.outcome.toUpperCase()}\n` +
        `Persona: ${persona?.displayName ?? m.persona_slug} ` +
        `(${persona?.summary ?? ""})\n` +
        `Judge reason: "${m.judge_reason ?? "(none)"}"\n` +
        `Skills used in this match: ${m.skills.length > 0 ? m.skills.join(", ") : "(none recorded)"}\n` +
        `Transcript:\n${transcriptToText(m.transcript)}`
      );
    })
    .join("\n\n");

  const styleBlock = JSON.stringify(
    {
      slug: input.style.slug,
      displayName: input.style.displayName,
      persona: input.style.persona,
      voice: input.style.voice,
      framework: input.style.framework,
      hooks: input.style.hooks,
      stages: input.style.stages,
      fewShot: input.style.fewShot,
      currently_attached_skills: input.currentSkills ?? [],
    },
    null,
    2,
  );

  const userMessage =
    `CURRENT STYLE:\n${styleBlock}\n\n` +
    `SAMPLE OF ${fullMatches.length} LOST/DRAW MATCHES:\n${transcriptsBlock}\n\n` +
    `Return the JSON proposal now.`;

  const messages: ChatMessage[] = [
    { role: "system", content: COACH_SYSTEM },
    { role: "user", content: userMessage },
  ];

  let raw: string;
  try {
    raw = await input.chat.complete(messages, {
      temperature: 0.2,
      ...(input.model ? { model: input.model } : {}),
      numPredict: 1500,
    });
  } catch (err) {
    return {
      summary: `Coach LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      edits: {},
      rationale: [],
    };
  }

  return parseProposal(raw);
}

/**
 * Tolerant JSON parser. Strips code fences, attempts JSON.parse, falls
 * back to extracting an outer object. Always returns a valid CoachProposal
 * (with raw output preserved on parse failure).
 */
export function parseProposal(raw: string): CoachProposal {
  const parsed = extractJsonObject(raw);
  if (parsed) return normalizeProposal(parsed, raw);
  return {
    summary: "(coach output unparseable — see raw)",
    edits: {},
    rationale: [],
    raw,
  };
}

/**
 * Pure function: apply a coach proposal's edits to a style spec, returning
 * a NEW style object. Original is untouched. Caller is responsible for
 * persisting via `StylesRepo.editAsNewVersion`.
 *
 * Merge rules:
 *   - voice_tone: replaces the existing voice.tone string verbatim.
 *   - voice_forbid_add: appended to voice.forbid (deduped).
 *   - hooks_add: appended to hooks. Invalid kinds (not in HOOK_KINDS) are
 *     silently dropped — coach-LLM occasionally hallucinates new categories.
 *   - stage_guidance: per-stage `guidance` field replaced. If the stage
 *     didn't exist, a minimal config is created (goal=stage name).
 *   - fewshot_add: appended to fewShot. Invalid stage values dropped.
 *   - skills_attach / skills_detach: NOT applied here — those are managed
 *     via the styles_skills join table, not the style.json itself. Caller
 *     handles via SkillsRepo.setStyleSkills().
 *
 * Returned style is NOT validated against StyleSchema — caller should run
 * `StyleSchema.parse(applied)` to catch any drift before persisting.
 */
export function applyEditsToStyle(
  style: Style,
  edits: CoachProposal["edits"],
): Style {
  const out: Style = {
    ...style,
    voice: { ...style.voice, forbid: [...style.voice.forbid] },
    hooks: [...style.hooks],
    stages: { ...style.stages },
    fewShot: [...style.fewShot],
  };

  if (typeof edits.voice_tone === "string" && edits.voice_tone.trim()) {
    out.voice.tone = edits.voice_tone.trim();
  }

  if (Array.isArray(edits.voice_forbid_add)) {
    const existing = new Set(out.voice.forbid);
    for (const phrase of edits.voice_forbid_add) {
      const t = phrase.trim();
      if (t && !existing.has(t)) {
        out.voice.forbid.push(t);
        existing.add(t);
      }
    }
  }

  if (Array.isArray(edits.hooks_add)) {
    const validKinds = new Set([
      "social_proof",
      "scarcity",
      "authority",
      "liking",
      "reciprocity",
      "commitment",
    ]);
    for (const h of edits.hooks_add) {
      if (validKinds.has(h.kind) && h.text.trim()) {
        out.hooks.push({
          kind: h.kind as Style["hooks"][number]["kind"],
          text: h.text.trim(),
        });
      }
    }
  }

  if (edits.stage_guidance) {
    for (const [k, guidance] of Object.entries(edits.stage_guidance)) {
      if (typeof guidance !== "string" || !guidance.trim()) continue;
      const stageKey = k as keyof Style["stages"];
      const existing = out.stages[stageKey];
      if (existing) {
        out.stages = {
          ...out.stages,
          [stageKey]: { ...existing, guidance: guidance.trim() },
        };
      } else {
        out.stages = {
          ...out.stages,
          [stageKey]: {
            goal: stageKey,
            guidance: guidance.trim(),
            groundingRequired: false,
          },
        };
      }
    }
  }

  if (Array.isArray(edits.fewshot_add)) {
    const validStages = new Set([
      "opener",
      "qualify",
      "pitch",
      "objection",
      "close",
    ]);
    for (const fs of edits.fewshot_add) {
      if (!fs.user.trim() || !fs.assistant.trim()) continue;
      const entry: Style["fewShot"][number] = {
        user: fs.user.trim(),
        assistant: fs.assistant.trim(),
      };
      if (fs.stage && validStages.has(fs.stage)) {
        entry.stage = fs.stage as Style["fewShot"][number]["stage"];
      }
      out.fewShot.push(entry);
    }
  }

  return out;
}

function normalizeProposal(p: unknown, raw: string): CoachProposal {
  if (!p || typeof p !== "object") {
    return { summary: "(empty proposal)", edits: {}, rationale: [], raw };
  }
  const obj = p as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" ? obj.summary : "(no summary)";
  const editsRaw = (
    obj.edits && typeof obj.edits === "object" ? obj.edits : {}
  ) as Record<string, unknown>;
  const rationale = Array.isArray(obj.rationale)
    ? obj.rationale.filter((r): r is string => typeof r === "string")
    : [];

  const edits: CoachProposal["edits"] = {};
  if (typeof editsRaw.voice_tone === "string")
    edits.voice_tone = editsRaw.voice_tone;
  if (Array.isArray(editsRaw.voice_forbid_add)) {
    edits.voice_forbid_add = editsRaw.voice_forbid_add.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(editsRaw.hooks_add)) {
    edits.hooks_add = (editsRaw.hooks_add as unknown[]).filter(
      (h): h is { kind: string; text: string } =>
        h !== null &&
        typeof h === "object" &&
        typeof (h as { kind?: unknown }).kind === "string" &&
        typeof (h as { text?: unknown }).text === "string",
    );
  }
  if (editsRaw.stage_guidance && typeof editsRaw.stage_guidance === "object") {
    const sg = editsRaw.stage_guidance as Record<string, unknown>;
    const out: NonNullable<CoachProposal["edits"]["stage_guidance"]> = {};
    for (const k of [
      "opener",
      "qualify",
      "pitch",
      "objection",
      "close",
    ] as const) {
      if (typeof sg[k] === "string") out[k] = sg[k] as string;
    }
    if (Object.keys(out).length > 0) edits.stage_guidance = out;
  }
  if (Array.isArray(editsRaw.fewshot_add)) {
    edits.fewshot_add = (editsRaw.fewshot_add as unknown[])
      .filter(
        (f): f is { user: string; assistant: string; stage?: string } =>
          f !== null &&
          typeof f === "object" &&
          typeof (f as { user?: unknown }).user === "string" &&
          typeof (f as { assistant?: unknown }).assistant === "string",
      )
      .map((f) => ({
        user: f.user,
        assistant: f.assistant,
        ...(typeof (f as { stage?: unknown }).stage === "string"
          ? { stage: (f as { stage: string }).stage }
          : {}),
      }));
  }
  if (Array.isArray(editsRaw.skills_attach)) {
    edits.skills_attach = editsRaw.skills_attach.filter(
      (s): s is string => typeof s === "string",
    );
  }
  if (Array.isArray(editsRaw.skills_detach)) {
    edits.skills_detach = editsRaw.skills_detach.filter(
      (s): s is string => typeof s === "string",
    );
  }

  return { summary, edits, rationale };
}
