import type { Style } from "@chatman-media/kb";
import { coldDirectPas } from "./cold-direct-pas.ts";
import { empatheticNepq } from "./empathetic-nepq.ts";
import { flirtyBelfort } from "./flirty-belfort.ts";

/**
 * Built-in sales-styles вертикали recruitment-uae. 3 production-curated стиля:
 *   - flirtyBelfort: молодёжный, прямолинейный сейл-флоу (Belfort/SPIN)
 *   - empatheticNepq: NEPQ (Neuro-Emotional Persuasion Questions) фреймворк
 *   - coldDirectPas: PAS (Problem-Agitate-Solve), сухой, без воды
 *
 * Все стили valid'ятся через StyleSchema на import (zod parse внутри
 * каждого *.ts). Если schema'а Style меняется — здесь упадёт compile-time.
 *
 * Seed-script читает этот массив и пишет каждый стиль в styles таблицу
 * как config_json: JSON.stringify(style).
 */
export const RECRUITMENT_UAE_STYLES: readonly Style[] = [
  flirtyBelfort,
  empatheticNepq,
  coldDirectPas,
];

export { coldDirectPas, empatheticNepq, flirtyBelfort };
