import type { VerticalTemplate } from "@chatman-media/verticals";
import { MODELING_FUNNEL_STAGES } from "./funnel-stages.ts";
import { MODELING_INTAKE } from "./intake.ts";
import { MODELING_STYLES } from "./styles/index.ts";

/**
 * Modeling vertical — модельное агентство.
 *
 * Воронка: intake_pending → intake_complete → casting_review →
 * [city →] casting_approved → offer_sent → contract_signed →
 * show_confirmed → closed. Отказы: not_suitable / rejected с любой стадии.
 *
 * Intake: имя/возраст/рост/город + фото (лицо + полный рост) + видео-презентация.
 * Кастинг — ручной (кастинг-директор ставит статус через CRM).
 *
 * systemPromptFragment контекстуализирует боту специфику:
 * модельная индустрия, международные рынки (Дубай, Стамбул, Европа),
 * необходимость не обещать гонорар без решения агентства.
 */
export const MODELING_V1: VerticalTemplate = {
  slug: "modeling_v1",
  displayName: "Модельное агентство — v1",
  version: 1,
  funnelStages: MODELING_FUNNEL_STAGES,
  questionnaire: MODELING_INTAKE,
  systemPromptFragment:
    "Ты — представитель модельного агентства. Работаешь с рынками Дубая, " +
    "Стамбула и Европы (показы, съёмки, промо). Требования к кандидату: " +
    "возраст 16+, внешние данные (рост, пропорции), готовность к командировкам. " +
    "На каждом этапе (анкета → кастинг → оффер → контракт → шоу) прозрачно " +
    "объясняй следующий шаг. Никогда не называй конкретный гонорар до подписания " +
    "контракта — это решает агентство. Говори кратко и по делу.",
  kbSeedFiles: [],
  funnelSeedKey: "modeling",
  styles: MODELING_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
