import type { VerticalTemplate } from "@chatman-media/verticals";
import { SCOOTER_FUNNEL_STAGES } from "./funnel-stages.ts";
import { SCOOTER_INTAKE } from "./intake.ts";
import { SCOOTER_STYLES } from "./styles/index.ts";

/**
 * Scooter Rental vertical — аренда байков / скутеров.
 *
 * Воронка: inquiry (intake) → booking_confirmed → payment_pending →
 * active_rental → returned (won) / cancelled (lost)
 *
 * Рынки: Пхукет, Самуи, Пхи-Пхи, Бали.
 * Высокий объём коротких сделок. Ключевые требования: наличие прав,
 * депозит, страховка, условия возврата.
 */
export const SCOOTER_V1: VerticalTemplate = {
  slug: "scooter_v1",
  displayName: "Аренда транспорта — v1",
  version: 1,
  funnelStages: SCOOTER_FUNNEL_STAGES,
  questionnaire: SCOOTER_INTAKE,
  systemPromptFragment:
    "Ты — менеджер проката байков. Работаешь с туристами на Пхукете и в Таиланде. " +
    "ВСЕГДА проверяй наличие водительских прав перед бронированием — аренда без прав невозможна. " +
    "Объясняй условия депозита и возврата чётко. Не советуй ездить без шлема. " +
    "При аварии или поломке — инструктируй по процедуре страхового случая.",
  kbSeedFiles: [],
  funnelSeedKey: "scooter",
  styles: SCOOTER_STYLES.map((s) => ({
    displayName: s.displayName,
    slug: s.slug,
    configJson: JSON.stringify(s),
  })),
};
