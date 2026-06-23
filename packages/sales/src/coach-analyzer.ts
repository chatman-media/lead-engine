import type {
  LeadRow,
  MessageRow,
  MessagesRepo,
  SkillOutcomesRepo,
} from "@chatman-media/conversation-engine";
import { gradeSkills } from "@chatman-media/kb";
import type { ChatClient } from "@chatman-media/llm-router";

/**
 * Coach analyzer — post-hoc разбор completed conversation'ов. После того как
 * lead закрылся (won/lost/ghosted), для каждой пары (user-question, bot-reply)
 * в transcript'е дёргает gradeSkills из @chatman-media/kb — возвращённые
 * skill-slugs пишутся в skill_outcomes таблицу с одним общим outcome'ом
 * лида.
 *
 * Результат используется:
 *   - admin-UI: win-rate per skill для inspect'а
 *   - coach-proposals: LLM-предложения по улучшению style'а на основе
 *     skill-aggregates
 *   - shadow-evaluations: pair-wise сравнения старого vs нового style'а
 *
 * Не блокирует основной reply pipeline — запускается отдельным admin-cron'ом.
 * Idempotent: uniq на (lead_id, skill_slug, source) защищает от дублей.
 */
export interface CoachAnalyzerOpts {
  /** Available skill slugs из styles[*].skills (или global skills table). */
  availableSlugs: readonly string[];
  /** Chat-LLM для gradeSkills. Тот же что reply-strategy. */
  resolveChat: (tenantId: number) => ChatClient;
  /** Опционально: lightweight model для grading (cheaper than main chat). */
  gradingModel?: string;
}

export interface AnalyzeLeadOpts {
  lead: LeadRow;
  conversationId: number;
  styleSlug: string | null;
  /**
   * Outcome для всех skill_outcomes этого лида. Извлекается caller'ом из
   * lead.state (например, ready_to_work → 'won', rejected → 'lost').
   */
  outcome: "won" | "lost" | "draw";
  /** Источник outcome'а: lead_submitted/lead_rejected/lead_ghosted/manual. */
  source: "lead_submitted" | "lead_rejected" | "lead_ghosted" | "manual" | "self_play";
  nowEpoch: number;
}

export interface AnalysisResult {
  /** Сколько message-пар (user+assistant) проанализировано. */
  pairsAnalyzed: number;
  /** Сколько skill_outcomes реально вставлено (после дедупа). */
  outcomesRecorded: number;
  /** Сколько skill_outcomes уже было (conflict) — для idempotency-tracking. */
  outcomesDuplicate: number;
}

export class CoachAnalyzer {
  constructor(private readonly opts: CoachAnalyzerOpts) {}

  /**
   * Анализирует все user→assistant пары в conversation, записывает skill_outcomes.
   * Pair = последовательное user-сообщение и сразу следующее assistant-сообщение
   * (skip system/human/самостоятельные).
   */
  async analyzeLead(
    deps: {
      messages: MessagesRepo;
      skillOutcomes: SkillOutcomesRepo;
    },
    input: AnalyzeLeadOpts,
  ): Promise<AnalysisResult> {
    // Грузим всю историю в порядке от старого к новому. Используем большой
    // limit — реалистично one full lead это ~100 сообщений; >1000 будет
    // chunk'аться в отдельных итерациях.
    const all = await deps.messages.recent(input.conversationId, 1000);

    const pairs = extractUserAssistantPairs(all);
    if (pairs.length === 0) {
      return { pairsAnalyzed: 0, outcomesRecorded: 0, outcomesDuplicate: 0 };
    }

    const chat = this.opts.resolveChat(input.lead.tenantId);
    let recorded = 0;
    let duplicate = 0;
    for (const pair of pairs) {
      // gradeSkills сам catches LLM exceptions → возвращает [] на failure.
      const skills = await gradeSkills({
        question: pair.userText,
        reply: pair.assistantText,
        availableSlugs: this.opts.availableSlugs,
        chat: chat as unknown as Parameters<typeof gradeSkills>[0]["chat"],
        ...(this.opts.gradingModel ? { model: this.opts.gradingModel } : {}),
      });
      for (const slug of skills) {
        const inserted = await deps.skillOutcomes.record({
          leadId: input.lead.id,
          skillSlug: slug,
          outcome: input.outcome,
          source: input.source,
          conversationId: input.conversationId,
          messageId: pair.assistantMessageId,
          styleSlug: input.styleSlug,
          nowEpoch: input.nowEpoch,
        });
        if (inserted) recorded += 1;
        else duplicate += 1;
      }
    }
    return {
      pairsAnalyzed: pairs.length,
      outcomesRecorded: recorded,
      outcomesDuplicate: duplicate,
    };
  }
}

/**
 * Из flat-массива messages извлекает пары (user → следующий assistant/human).
 * Стандартный alternating-pattern: user, assistant, user, assistant. Если
 * после user идёт ещё user (бот не отвечал) — pair пропускается.
 */
export function extractUserAssistantPairs(messages: readonly MessageRow[]): Array<{
  userText: string;
  assistantText: string;
  assistantMessageId: number;
}> {
  const pairs: Array<{ userText: string; assistantText: string; assistantMessageId: number }> = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const a = messages[i]!;
    const b = messages[i + 1]!;
    if (a.role !== "user") continue;
    if (b.role !== "assistant" && b.role !== "human") continue;
    if (!a.text || !b.text) continue;
    pairs.push({ userText: a.text, assistantText: b.text, assistantMessageId: b.id });
  }
  return pairs;
}
