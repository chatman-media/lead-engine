import type { VerticalTemplate } from "@chatman-media/verticals";
import { RECRUITMENT_FUNNEL_STAGES } from "./funnel-stages.ts";
import { RECRUITMENT_INTAKE } from "./intake.ts";
import { RECRUITMENT_STYLES } from "./styles/index.ts";

/**
 * Recruitment vertical. Воронка: кандидатки на работу артисток (хостес, танцовщицы)
 * через подачу рабочей визы (отсюда вопросы про консульские данные и
 * историю поездок).
 *
 * Funnel: intake_pending → intake_complete → approved → docs_pending →
 * docs_complete → visa_form → visa_filing → visa_waiting → ready_to_work
 * → closed. Откат в rejected возможен с любой не-terminal stage до
 * ready_to_work.
 *
 * Intake — 15-item checklist (имя/возраст/рост/языки/паспорт/фото/видео
 * танца). Visa-form — step-by-step interview по ~32 полям (заполняется
 * на латинице, как в паспорте) — детали в visa-interview.ts.
 *
 * systemPromptFragment добавляется conversation-engine'ом в системный
 * промпт стиля. Здесь мы помечаем боту, что он работает в воронке найма
 * на работу за рубежом с визовыми требованиями — без этого бот может
 * "забыть" специфику и отвечать generic'ом про рекрутинг.
 */
export const RECRUITMENT_V1: VerticalTemplate = {
  slug: "recruitment_v1",
  displayName: "Рекрутинг и найм — v1",
  version: 1,
  funnelStages: RECRUITMENT_FUNNEL_STAGES,
  questionnaire: RECRUITMENT_INTAKE,
  systemPromptFragment:
    "Ты — представитель агентства по найму артисток (хостес, танцовщицы, " +
    "певицы) для работы за рубежом. Контракты — от 3 месяцев. Главные " +
    "требования к кандидатке: возраст 18+, действующий загранпаспорт, " +
    "готовность выезда. На каждом этапе воронки (анкета → одобрение → " +
    "документы → визовая анкета → отъезд) ты прозрачно объясняешь, что " +
    "будет дальше. Никогда не обещай конкретный заработок до подписания " +
    "контракта — это решает партнёр.",
  kbSeedFiles: [],
  funnelSeedKey: "recruitment",
  styles: RECRUITMENT_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
