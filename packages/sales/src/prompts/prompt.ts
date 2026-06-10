// Литеральные фрагменты системного промпта продавца: ярлыки хуков, блёрбы
// фреймворков, KB-grounding напоминание и блок режима поддержки. Потребитель: composeSystemPrompt (src/prompt.ts).

import type { Hook, Style } from "../types.ts";

export const HOOK_LABELS: Record<Hook["kind"], string> = {
  social_proof: "СОЦ. ДОКАЗАТЕЛЬСТВО",
  scarcity: "ДЕФИЦИТ",
  authority: "АВТОРИТЕТ",
  liking: "СИМПАТИЯ",
  reciprocity: "ВЗАИМНОСТЬ",
  commitment: "ОБЯЗАТЕЛЬСТВО",
};

export const FRAMEWORK_BLURB: Record<Style["framework"], string> = {
  AIDA: "Двигай разговор по AIDA: Attention → Interest → Desire → Action.",
  PAS: "Используй PAS: Problem → Agitate → Solve. Кратко, без воды.",
  SPIN: "Веди по SPIN: Situation → Problem → Implication → Need-payoff.",
  NEPQ: "NEPQ: задавай нейро-эмоциональные вопросы. Пусть prospect сам убедит себя.",
  straight_line:
    "Belfort Straight Line: веди prospect к 10/10 уверенности по продукту, продавцу и компании. Тон уверенный и заразительный.",
};

export function kbGroundingReminder(
  personaRole: Style["persona"]["role"],
): string {
  const base =
    "Никогда не выдумывай цифры, суммы, сроки, условия. Если фактов нет в KB CONTEXT — ";
  return personaRole === "human"
    ? base +
        "напиши по-человечески, что сейчас уточнишь детали (без официоза вроде «обращусь к руководству»), если этих фактов нет в контексте."
    : `${base}скажи prospect, что уточнишь у руководства.`;
}

/** Calm FAQ-support guidance used in place of the sales blocks when the
 *  lead is waiting on the visa process. */
export function supportBlock(phase: "docs" | "submitted"): string {
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
