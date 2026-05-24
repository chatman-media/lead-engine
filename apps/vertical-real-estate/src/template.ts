import type { VerticalTemplate } from "@chatman-media/verticals";
import { REAL_ESTATE_FUNNEL_STAGES } from "./funnel-stages.ts";
import { REAL_ESTATE_INTAKE } from "./intake.ts";
import { REAL_ESTATE_STYLES } from "./styles/index.ts";

/**
 * Real estate vertical. Воронка: продажа недвижимости в Дубае (первичка и вторичка).
 *
 * Объекты хранятся в KB как документы — бот делает hybridSearch по запросу
 * клиента и предлагает подходящие варианты. Каждый объект — один KB-документ
 * с полями: тип, район, цена, площадь, статус, yield, ссылка на листинг.
 *
 * Funnel: qualification (intake) → viewings → offer_negotiation →
 * mou_signed → noc_application? → mortgage_approval? → dld_transfer (won)
 * | deal_lost. Стадии NOC и ипотека опциональны — зависят от сделки.
 *
 * systemPromptFragment указывает боту контекст рынка UAE: DLD-трансфер,
 * NOC для вторички, ипотечные требования (LTV, срок), residency visa
 * при покупке от $205k. Бот не обещает yield без данных из KB.
 */
export const REAL_ESTATE_V1: VerticalTemplate = {
  slug: "real_estate_v1",
  displayName: "Недвижимость (Дубай) — v1",
  version: 1,
  funnelStages: REAL_ESTATE_FUNNEL_STAGES,
  questionnaire: REAL_ESTATE_INTAKE,
  systemPromptFragment:
    "Ты — брокер по недвижимости в Дубае. Рынок UAE: DLD-трансфер, " +
    "NOC от застройщика для вторички, ипотека до 75% LTV для резидентов. " +
    "При покупке от AED 750k (~$205k) покупатель может получить visa резидента. " +
    "Используй KB для подборки объектов — описывай район, метраж, цену и yield " +
    "только из KB CONTEXT. Не обещай доходность без подтверждённых данных. " +
    "На каждом этапе воронки объясняй покупателю следующий шаг: просмотр → " +
    "оффер → MOU (Form F + депозит 10%) → NOC/ипотека → DLD-трансфер.",
  kbSeedFiles: [],
  funnelSeedKey: "real_estate",
  styles: REAL_ESTATE_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
