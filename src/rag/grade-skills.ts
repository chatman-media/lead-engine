/**
 * After the bot has generated a reply, optionally ask a small LLM to
 * inspect the (system_prompt → user → assistant) triple and report which
 * of the configured skills (slugs) it actually used. Output goes into
 * `messages.meta_json.telemetry.skills_used` for downstream attribution
 * (Phase 2: ELO over outcomes; Phase 3: self-play).
 *
 * Cost: +1 LLM call per assistant turn. Gated behind RAG_SKILL_GRADING=true
 * because for high-volume single-style production it's overkill — flip on
 * during A/B research windows, off in steady state.
 *
 * Failure-soft: any error → returns empty array, never throws. The whole
 * point is post-hoc analytics, not a hard dependency.
 */
import type { ChatClient } from "./chat.ts";

export interface GradeSkillsInput {
  question: string;
  reply: string;
  /** Slugs offered to the model in the system prompt (only these are valid). */
  availableSlugs: readonly string[];
  chat: ChatClient;
  /** Lightweight model id — falls back to the chat client's default if undefined. */
  model?: string;
}

const SYSTEM = (slugs: readonly string[]) =>
  `You are a sales-conversation auditor. Given a candidate's question and a salesperson's reply, identify which persuasion skills (from the allowed list below) the reply actually demonstrates.\n\nALLOWED SKILLS:\n${slugs.map((s) => `- ${s}`).join("\n")}\n\nReturn ONLY a JSON array of slugs from the allowed list. Empty array if none clearly apply. No commentary, no markdown, no explanation. Be conservative: only include a slug when the reply demonstrably USES the technique, not just touches its theme.\n\nCue patterns (when each skill is "demonstrably USED"):\n  social-proof-stat: explicit number/% of past results ("70% наших девочек закрывают за 2 недели") → include.\n  tactical-empathy: names candidate's emotion verbatim ("звучит, что ты переживаешь о..." / "кажется, тебе важна стабильность") → include.\n  calibrated-question: open "как / что / почему" question that can't be answered yes/no ("как ты сейчас представляешь идеальный вариант?") → include.\n  liking-genuine-compliment: a SPECIFIC sincere compliment to the candidate (energy / style / sharp question / good русский) — NOT generic "красавица". Even one short line counts ("вижу, ты задаёшь правильные вопросы — это редкость" / "по фото — энергия чувствуется"). → include.\n  accusation-audit: salesperson VOICES the candidate's fear/objection BEFORE the candidate raises it ("наверное это звучит как развод" / "понимаю, кажется, что слишком хорошо чтобы быть правдой" / "догадываюсь, ты думаешь — а вдруг кинут") → include.\n  authority-license: cites concrete legal/contractual mechanism ("договор подписывается ДО вылета" / "виза оформляется агентством на их стороне" / "официальный контракт с работодателем" / "никаких выплат в счёт работы") → include.\n  scarcity-spots-left: explicit limited-slots phrasing ("3-5 мест на поток" / "разбирают за неделю" / "ближайший вылет почти набран") → include.\n  reciprocity-free-info: shares useful info WITHOUT asking for commitment in the same breath ("кстати, в Сеуле сейчас сезон — поэтому ставки выше") → include.\n  unity-belonging: uses "мы / наши девочки / наша команда" framing instead of impersonal "у нас" ("наши девочки в Шанхае пишут что..." / "мы тебя сопровождаем до прилёта") → include.\n  commitment-microyes: stacks 2+ short confirmations before a bigger ask ("21? ок. паспорт есть? ок. готова на 3 месяца?") → include.\n  mirroring: repeats candidate's last 1-3 words as a question ("не уверена?" / "слишком далеко?") → include.\n  Reply just answers a factual question with no persuasion technique → return [].`;

export async function gradeSkills(input: GradeSkillsInput): Promise<string[]> {
  if (input.availableSlugs.length === 0) return [];
  try {
    const raw = await input.chat.complete(
      [
        { role: "system", content: SYSTEM(input.availableSlugs) },
        {
          role: "user",
          content: `Candidate: ${input.question}\n\nSalesperson reply: ${input.reply}\n\nReturn JSON array of skill slugs used (subset of allowed list).`,
        },
      ],
      {
        temperature: 0,
        ...(input.model ? { model: input.model } : {}),
        numPredict: 80,
      },
    );
    return parseSlugList(raw, input.availableSlugs);
  } catch (err) {
    console.warn("[grade-skills] LLM call failed:", err);
    return [];
  }
}

/** Tolerant parser — accepts a bare JSON array, code-fenced JSON, or
 *  comma-separated text. Filters to allowed slugs. Exported for tests. */
export function parseSlugList(raw: string, allowed: readonly string[]): string[] {
  if (!raw) return [];
  const allowSet = new Set(allowed);
  // Try JSON first.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => allowSet.has(s));
    }
  } catch {
    /* fall through to plain-text split */
  }
  return stripped
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/^["'-]+|["'-]+$/g, ""))
    .filter((s) => allowSet.has(s));
}
