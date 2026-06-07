import type { VerticalTemplate } from "@chatman-media/verticals";
import { VISA_FUNNEL_STAGES } from "./funnel-stages.ts";
import { VISA_INTAKE } from "./intake.ts";
import { VISA_STYLES } from "./styles/index.ts";

/**
 * Visa & Immigration vertical — визовое агентство.
 *
 * Воронка: qualification (intake) → documents_collection →
 * financial_verification → application_submission → processing →
 * visa_issued (won) / rejected (lost)
 *
 * Поддерживает: UAE, Таиланд, UK, Schengen, Австралия.
 * Ключевые особенности: сбор паспортных фото, финансовые документы,
 * строгий запрет обещать одобрение.
 */
export const VISA_V1: VerticalTemplate = {
  slug: "visa_v1",
  displayName: "Визовое агентство — v1",
  version: 1,
  funnelStages: VISA_FUNNEL_STAGES,
  questionnaire: VISA_INTAKE,
  systemPromptFragment:
    "Ты — консультант визового агентства. Помогаешь клиентам оформить визы в ОАЭ, Таиланд, " +
    "Великобританию, Шенген и другие страны. НИКОГДА не обещай одобрение визы — это решает " +
    "посольство. Собирай данные честно, объясняй требования точно. При рисках — предупреждай " +
    "заранее. Паспортные данные обрабатывай аккуратно, не цитируй их в ответах.",
  kbSeedFiles: [],
  funnelSeedKey: "visa",
  styles: VISA_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
