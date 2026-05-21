import type { Style } from "@chatman-media/kb";
import { alinaInfinity } from "./alina-infinity.ts";
import { coldDirectPas } from "./cold-direct-pas.ts";
import { empatheticNepq } from "./empathetic-nepq.ts";
import { flirtyBelfort } from "./flirty-belfort.ts";

/**
 * Built-in sales-styles вертикали recruitment-uae. Portовано из
 * sales-guru/src/sales/styles/. 4 production-curated стиля:
 *   - alinaInfinity: брендовый, длинные fewShot'ы, сильная persona
 *   - flirtyBelfort: молодёжный, более прямолинейный сейл-флоу
 *   - empatheticNepq: NEPQ (Never-Ever-Pretend-to-Qualify) фреймворк
 *   - coldDirectPas: PAS (Problem-Agitate-Solve), сухой, без воды
 *
 * Все 4 valid'ятся через rag's StyleSchema на import (zod parse внутри
 * каждого *.ts). Если schema'а Style в rag меняется — здесь упадёт
 * compile-time, что нужно для безопасных рефакторов.
 *
 * Seed-script читает этот массив и пишет каждый стиль в styles таблицу
 * как config_json: JSON.stringify(style).
 */
export const RECRUITMENT_UAE_STYLES: readonly Style[] = [
  alinaInfinity,
  flirtyBelfort,
  empatheticNepq,
  coldDirectPas,
];

export { alinaInfinity, coldDirectPas, empatheticNepq, flirtyBelfort };
