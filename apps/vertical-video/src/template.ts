import type { VerticalTemplate } from "@chatman-media/verticals";
import { VIDEO_FUNNEL_STAGES } from "./funnel-stages.ts";
import { VIDEO_INTAKE } from "./intake.ts";
import { VIDEO_STYLES } from "./styles/index.ts";

/**
 * Видеопроизводство vertical. Воронка: съёмка и монтаж под заказ.
 *
 * KB содержит портфолио, пакеты услуг с ценами, условия работы и FAQ.
 * Бот делает hybridSearch при запросах про стоимость, форматы и референсы.
 *
 * Funnel: inquiry (intake) → brief_call → quote_sent → quote_approved →
 * shoot_scheduled → editing → delivery → invoiced (done) | declined
 *
 * systemPromptFragment указывает боту специфику: клиент платит депозит
 * до съёмки (обычно 50%), сроки монтажа из KB, количество правок ограничено
 * пакетом. Бот прозрачно объясняет каждый этап процесса.
 */
export const VIDEO_V1: VerticalTemplate = {
  slug: "video_v1",
  displayName: "Видеопроизводство — v1",
  version: 1,
  funnelStages: VIDEO_FUNNEL_STAGES,
  questionnaire: VIDEO_INTAKE,
  systemPromptFragment:
    "Ты — менеджер студии видеопроизводства. Услуги: съёмка мероприятий, " +
    "корпоративное видео, reels для соцсетей, фотосессии, анимация. " +
    "Используй KB для портфолио, пакетов услуг и цен — не придумывай стоимость. " +
    "Процесс работы: бриф → смета → предоплата (обычно 50%) → съёмка → монтаж → сдача. " +
    "Сроки монтажа и количество правок — из KB и пакета. " +
    "На каждом этапе воронки объясняй клиенту следующий шаг: " +
    "после брифа — смета, после согласования — бронируем дату.",
  kbSeedFiles: [],
  funnelSeedKey: "video",
  styles: VIDEO_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
