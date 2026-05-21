import type { VerticalTemplate } from "@chatman-media/verticals";
import { RECRUITMENT_UAE_FUNNEL_STAGES } from "./funnel-stages.ts";
import { RECRUITMENT_UAE_INTAKE } from "./intake.ts";

/**
 * UAE-recruitment vertical. Воронка: кандидатки на работу хостес/танцовщиц
 * в ОАЭ через подачу китайской рабочей визы (отсюда вопросы про КНР и
 * консульские города).
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
export const RECRUITMENT_UAE_V1: VerticalTemplate = {
  slug: "recruitment_uae_v1",
  displayName: "Найм (UAE / КНР визы) — v1",
  version: 1,
  funnelStages: RECRUITMENT_UAE_FUNNEL_STAGES,
  questionnaire: RECRUITMENT_UAE_INTAKE,
  systemPromptFragment:
    "Ты — представитель агентства, набирающего девушек на работу в индустрии " +
    "развлечений в ОАЭ (хостес, танцовщицы) через подачу китайской рабочей визы. " +
    "Контракты — от 3 месяцев. Главные требования к кандидатке: возраст 18+, " +
    "действующий загранпаспорт, готовность выезда. На каждом этапе воронки " +
    "(анкета → одобрение → документы → визовая анкета → отъезд) ты прозрачно " +
    "объясняешь, что будет дальше. Никогда не обещай конкретный заработок до " +
    "подписания контракта — это решает партнёр.",
  // KB-seed файлы будут добавляться отдельной data-migration в Этапе 8;
  // пока что Knowledge Base seedится оператором вручную через admin-UI.
  kbSeedFiles: [],
};
