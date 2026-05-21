import { FUNNEL_STAGES, type FunnelStage } from "@chatman-media/kb";
import type { ChatClient } from "@chatman-media/llm-router";
// Pipeline contract `StageClassifier` живёт в conversation-engine — это часть
// pipeline-deps shape'а, не sales-domain. Sales реализует контракт.
import type { StageClassifier } from "@chatman-media/conversation-engine";

/**
 * Regex-based стратегия классификации sales-stage'а. Быстрая (без LLM
 * call), но узкая — годится для smoke-классификации в одной вертикали.
 * Покрывает русскоязычные паттерны recruitment-uae.
 *
 * Приоритет правил (если несколько match'ятся):
 *   close > objection > qualify > pitch > opener
 *
 * История: до PR refactor/sales-consolidation-2 этот класс жил в
 * conversation-engine. Переехал сюда как sales-domain логика (5 stages —
 * это sales abstraction, regex-паттерны — sales heuristics).
 */
export class RegexStageClassifier implements StageClassifier {
  classify(input: {
    tenantId: number;
    userMessageText: string;
    previousStage: string | null;
    isFirstUserMessage: boolean;
  }): FunnelStage | null {
    void input.tenantId; // regex-impl не использует tenantId (нет LLM call'а)
    const text = input.userMessageText.toLowerCase().trim();
    if (text.length === 0) return input.previousStage as FunnelStage | null;

    // Close-сигналы: явное согласие, готовность к next step.
    // NOTE: \b в JS regex не работает с кириллицей (ASCII-only word chars),
    // поэтому используем простой substring-match. Lowercase'нули выше.
    if (
      /(согла(сна|сен|сно)|давай(те)?|поехали|готов(а)?|^ок(ей)?\b|да,?\s*хочу|когда\s+начин(а|ё)м|подпис(ат|ыв))/.test(
        text,
      )
    ) {
      return "close";
    }
    // Objection-сигналы: сомнения, вопросы-возражения.
    if (
      /(почему|зачем|а\s+что\s+если|сомнева|боюсь|не\s+уверен|не\s+нрав|обман|развод|неудобно|дорого)/.test(
        text,
      )
    ) {
      return "objection";
    }
    // Qualify-сигналы: первичный sharing данных о себе.
    if (
      /(меня\s+зовут|мне\s+\d+|я\s+из|я\s+живу|опыт\s+работ|говорю\s+(на\s+)?(английск|испанск|китайск))/.test(
        text,
      )
    ) {
      return "qualify";
    }
    // Pitch-сигналы: вопросы про деньги / условия (бот должен питчить).
    if (/(сколько\s+(плат|зараб)|какая\s+зарплат|условия|контракт|оплат)/.test(text)) {
      return "pitch";
    }
    // Первое сообщение и нет сигналов — opener stage.
    if (input.isFirstUserMessage) return "opener";
    // Иначе оставляем prev (no signal = no transition).
    return input.previousStage as FunnelStage | null;
  }
}

/**
 * LLM-based стратегия. Шлёт системный prompt с описанием 5 stages в
 * ChatClient.complete, парсит JSON-ответ. Точнее regex'а, но дорогая
 * (LLM call per message). Используется когда regex даёт null (fallback)
 * или для high-stakes воронок где ошибка classification стоит дорого.
 */
export class LlmStageClassifier implements StageClassifier {
  constructor(
    private readonly opts: {
      resolveChat: (tenantId: number) => ChatClient;
      /** Default 0.6. Ниже — больше нулей; выше — больше false-positives. */
      confidenceThreshold?: number;
    },
  ) {}

  async classify(input: {
    tenantId: number;
    userMessageText: string;
    previousStage: string | null;
    isFirstUserMessage: boolean;
  }): Promise<FunnelStage | null> {
    if (input.userMessageText.length === 0) {
      return input.previousStage as FunnelStage | null;
    }
    const chat = this.opts.resolveChat(input.tenantId);
    const stagesList = FUNNEL_STAGES.join(" | ");
    const reply = await chat.complete(
      [
        {
          role: "system",
          content:
            `Ты классифицируешь sales-stage реплики кандидата в воронке найма. ` +
            `Stages: ${stagesList}. ` +
            `\nopener — первый контакт, приветствие.` +
            `\nqualify — кандидат делится данными о себе (возраст, город, опыт).` +
            `\npitch — кандидат интересуется условиями / деньгами.` +
            `\nobjection — возражение, сомнение, "почему".` +
            `\nclose — согласие, готовность к следующему шагу.` +
            `\n\nОтветь строго JSON-объектом без markdown: ` +
            `{"stage":"<one of stages>","confidence":<0..1>}. ` +
            `Если уверенности нет — confidence < 0.5.`,
        },
        {
          role: "user",
          content:
            `Предыдущая стадия: ${input.previousStage ?? "none"}\n` +
            `Реплика: "${input.userMessageText}"\n` +
            `Ответ:`,
        },
      ],
      { temperature: 0.1, numPredict: 100 },
    );

    const threshold = this.opts.confidenceThreshold ?? 0.6;
    const parsed = parseLlmStageReply(reply);
    if (!parsed || parsed.confidence < threshold) {
      return input.previousStage as FunnelStage | null;
    }
    return parsed.stage;
  }
}

function parseLlmStageReply(raw: string): { stage: FunnelStage; confidence: number } | null {
  // Defensive parse: LLM может вернуть с code-fence или преамбулой. Ищем
  // первый {...} блок.
  const match = raw.match(/\{[^}]*"stage"[^}]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const stage = obj.stage;
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
    if (typeof stage !== "string" || !FUNNEL_STAGES.includes(stage as FunnelStage)) {
      return null;
    }
    return { stage: stage as FunnelStage, confidence };
  } catch {
    return null;
  }
}
