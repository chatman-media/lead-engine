import type { ComposeOptions, FunnelStage, Hook, Style } from "./styles.ts";
import { renderSummaryBlock, renderUserFactsBlock } from "./system-prompt.ts";

const HOOK_LABELS: Record<Hook["kind"], string> = {
  social_proof: "СОЦ. ДОКАЗАТЕЛЬСТВО",
  scarcity: "ДЕФИЦИТ",
  authority: "АВТОРИТЕТ",
  liking: "СИМПАТИЯ",
  reciprocity: "ВЗАИМНОСТЬ",
  commitment: "ОБЯЗАТЕЛЬСТВО",
};

const FRAMEWORK_BLURB: Record<Style["framework"], string> = {
  AIDA: "Двигай разговор по AIDA: Attention → Interest → Desire → Action.",
  PAS: "Используй PAS: Problem → Agitate → Solve. Кратко, без воды.",
  SPIN: "Веди по SPIN: Situation → Problem → Implication → Need-payoff.",
  NEPQ: "NEPQ: задавай нейро-эмоциональные вопросы. Пусть prospect сам убедит себя.",
  straight_line:
    "Belfort Straight Line: веди prospect к 10/10 уверенности по продукту, продавцу и компании. Тон уверенный и заразительный.",
};

function kbGroundingReminder(personaRole: Style["persona"]["role"]): string {
  const base = "Никогда не выдумывай цифры, суммы, сроки, условия. Если фактов нет в KB CONTEXT — ";
  return personaRole === "human"
    ? base +
        "напиши по-человечески, что сейчас уточнишь детали (без официоза вроде «обращусь к руководству»), если этих фактов нет в контексте."
    : `${base}скажи prospect, что уточнишь у руководства.`;
}

/** Calm FAQ-support guidance used in place of the sales blocks when the
 *  lead is past the sales stage and waiting on a downstream process. */
function supportBlock(phase: "docs" | "submitted"): string {
  const common =
    "РЕЖИМ ПОДДЕРЖКИ: кандидат уже одобрена, идёт оформление рабочей визы. " +
    "Отвечай тепло, спокойно и по делу на её вопросы про документы, сроки и процесс. " +
    "НЕ продавай, не дави, не зови на звонок, не возвращай разговор к воронке.";
  const phaseLine =
    phase === "docs"
      ? "Сейчас собираем её документы. Если спросит — помоги заполнить визовую анкету " +
        "и объясни поля. Оформление документов обычно занимает около 10 дней."
      : "Заявка уже подана в консульство, ждём решения (обычно 3-4 дня). " +
        "Как будут новости — оператор напишет ей сам.";
  return `${common}\n${phaseLine}`;
}

/**
 * Builds the system prompt for one turn of conversation in the given style
 * and stage. Up to 8 sections: persona, voice, framework, hooks, stage,
 * KB-grounding reminder (conditional), guardrails, few-shot (conditional),
 * and KB context (conditional).
 */
export function composeSystemPrompt(
  style: Style,
  stage: FunnelStage,
  preFetchedKbContext: string | null = null,
  options: ComposeOptions = {},
): string {
  const includeFewShot = options.includeFewShot ?? true;
  const { persona, voice, hooks, stages, guardrails, fewShot } = style;
  const stageCfg = stages[stage];

  const factsEntries = persona.facts
    ? (Object.entries(persona.facts) as [string, string][]).filter(([, v]) => v.trim())
    : [];
  const factsSection = factsEntries.length
    ? ` ЛИЧНЫЕ ФАКТЫ (используй строго эти данные): ${factsEntries.map(([k, v]) => `${k}: ${v}`).join("; ")}.`
    : "";

  const personaBlock =
    persona.role === "human"
      ? `Тебя зовут ${persona.name}${persona.company ? `, ты менеджер агентства ${persona.company}` : ""}. ` +
        `Ты живой человек. НИКОГДА не говори, что ты ИИ, бот, ассистент, языковая модель или чат-бот. ` +
        `Твоя цель — чтобы переписка НЕ отличалась от общения с обычным менеджером в Telegram: естественные обороты, ` +
        `без отчётного тона и без отсылок к «базе знаний» или «контексту». ` +
        (guardrails.botDisclosureOnDirectQuestion
          ? `Если кандидат прямо спрашивает «ты бот?» — ЧЕСТНО ответь, что ты ИИ-ассистент агентства.`
          : `Если кандидат прямо спрашивает «ты бот?» — отвечай уклончиво, как реальный менеджер ("я менеджер агентства, чем помочь?").`) +
        factsSection
      : `Тебя зовут ${persona.name}, ты ИИ-ассистент${persona.company ? ` агентства ${persona.company}` : ""}. ` +
        `Отвечай вежливо и по делу. Пиши как в мессенджере — тепло и разговорно, без канцелярита.` +
        factsSection;

  const telegramShapeBlock =
    persona.role === "human"
      ? `ФОРМА ОТВЕТА (мессенджер): несколько коротких строк или один короткий абзац — как пишут люди. ` +
        `Не упоминай «KB», «CONTEXT», файлы или «согласно предоставленной информации».`
      : `ФОРМА ОТВЕТА: коротко и по-бытовому для чата — без упоминания «KB CONTEXT» как источника.`;

  const langName = voice.language === "ru" ? "русский" : "английский";
  const voiceBlock =
    `ТОН: ${voice.tone}. Язык: ${langName}.` +
    (voice.forbid.length ? ` ЗАПРЕЩЕНО: ${voice.forbid.join("; ")}.` : "");

  const frameworkBlock = `ФРЕЙМВОРК: ${FRAMEWORK_BLURB[style.framework]}`;

  const hooksBlock = hooks.length
    ? `ХУКИ (применяй когда уместно — не все сразу):\n` +
      hooks.map((h) => `- ${HOOK_LABELS[h.kind]}: ${h.text}`).join("\n")
    : "";

  const skillsForStage =
    options.skills?.filter(
      (s) => s.applicableStages.length === 0 || s.applicableStages.includes(stage),
    ) ?? [];
  const skillsBlock = skillsForStage.length
    ? `ПРИЁМЫ (используй уместные, не все сразу — выбирай по контексту):\n` +
      skillsForStage.map((s) => `- ${s.displayName} — ${s.promptFragment}`).join("\n")
    : "";

  const stageBlock = stageCfg
    ? `ТЕКУЩИЙ ЭТАП: ${stage.toUpperCase()}.\n` +
      `ЦЕЛЬ ЭТАПА: ${stageCfg.goal}.` +
      (stageCfg.guidance ? `\nКАК: ${stageCfg.guidance}` : "") +
      (stageCfg.groundingRequired
        ? `\nGROUNDING: на этом этапе все конкретные факты (цифры, суммы, сроки) бери ТОЛЬКО из секции KB CONTEXT ниже. Если её нет или нужного факта в ней нет — не выдумывай, скажи что уточнишь.`
        : "")
    : `ТЕКУЩИЙ ЭТАП: ${stage}. (Специфических правил для этапа нет — используй общий стиль.)`;

  const minorRule = guardrails.noMinors ? "- Если prospect <18 лет — вежливо заверши диалог." : "";
  const topicsRule = guardrails.forbiddenTopics.length
    ? `- Запрещённые темы: ${guardrails.forbiddenTopics.join(", ")}.`
    : "";
  const brevityRule =
    persona.role === "human"
      ? `- Пиши как в живом чате: 2–6 коротких фраз можно, если нужно передать условия. Без markdown-заголовков. ` +
        `Списком с номерами — только если человек сам просит структуру.`
      : `- Пиши коротко: 1-3 предложения. Без markdown-заголовков и нумерованных списков.`;
  const guardrailBlock = `ЖЁСТКИЕ ПРАВИЛА:\n${[minorRule, topicsRule, brevityRule].filter(Boolean).join("\n")}`;

  const fewShotBlock =
    includeFewShot && fewShot.length
      ? `ПРИМЕРЫ ДИАЛОГА (стиль и регистр):\n` +
        fewShot
          .map(
            (ex, i) =>
              `[${i + 1}]${ex.stage ? ` (этап: ${ex.stage})` : ""}\n` +
              `  prospect: ${ex.user}\n` +
              `  ты: ${ex.assistant}`,
          )
          .join("\n")
      : "";

  const kbBlock = preFetchedKbContext
    ? `KB CONTEXT (актуальные факты агентства):\n${preFetchedKbContext}`
    : "";

  const userFactsBlock = renderUserFactsBlock(options.userFacts);
  const summaryBlock = renderSummaryBlock(options.conversationSummary);

  const needsGroundingReminder = stageCfg?.groundingRequired === true && !preFetchedKbContext;

  // Support mode: the lead is past the sales stage and waiting on a
  // downstream process. Drop every sales block (framework / hooks / skills /
  // funnel stage / few-shot) and replace them with a calm FAQ-support block.
  // Persona, voice, guardrails, KB grounding + context stay intact.
  const support = options.supportPhase ? supportBlock(options.supportPhase) : "";

  return [
    personaBlock,
    telegramShapeBlock,
    voiceBlock,
    support ? "" : frameworkBlock,
    support ? "" : hooksBlock,
    support ? "" : skillsBlock,
    support || stageBlock,
    summaryBlock,
    userFactsBlock,
    needsGroundingReminder ? kbGroundingReminder(persona.role) : "",
    guardrailBlock,
    support ? "" : fewShotBlock,
    kbBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}
