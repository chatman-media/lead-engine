import type { VerticalTemplate } from "@chatman-media/verticals";
import { SAAS_FUNNEL_STAGES } from "./funnel-stages.ts";
import { SAAS_INTAKE } from "./intake.ts";
import { SAAS_STYLES } from "./styles/index.ts";

/**
 * SaaS-продажи vertical. Продаём сам Lead Engine B2B-клиентам.
 *
 * Входящий лид — бизнес, который рассматривает автоматизацию обработки
 * входящих через AI-бота. Бот квалифицирует лид, собирает контекст о
 * бизнесе, объясняет ценность продукта и назначает демо.
 *
 * KB должна содержать:
 * - Тарифные планы и описание фич
 * - Кейсы (рекрутинг, недвижимость, e-commerce)
 * - FAQ (безопасность, интеграции, онбординг)
 * - Сравнение с альтернативами (если нужно)
 *
 * Funnel: discovery (intake) → qualified → demo_scheduled → demo_done →
 * proposal_sent → negotiation → signed (won) | lost
 */
export const SAAS_V1: VerticalTemplate = {
  slug: "saas_v1",
  displayName: "SaaS-продажи — v1",
  version: 1,
  funnelStages: SAAS_FUNNEL_STAGES,
  questionnaire: SAAS_INTAKE,
  systemPromptFragment:
    "Ты — менеджер по продажам Lead Engine, SaaS-платформы для автоматизации " +
    "входящих лидов через AI-ботов в Telegram, WhatsApp и web-виджете. " +
    "Клиент — бизнес с входящим потоком лидов (найм, недвижимость, e-commerce, услуги). " +
    "Твоя цель: понять боль клиента, показать как Lead Engine решает задачу, " +
    "назначить демо. Используй KB для тарифов, кейсов и FAQ. " +
    "Не обещай функциональность которой нет в KB. " +
    "Демо — главная цель каждого разговора.",
  kbSeedFiles: [],
  funnelSeedKey: "saas",
  styles: SAAS_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
