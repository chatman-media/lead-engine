import type { Style } from "@chatman-media/rag";
import type { ExperimentRow, StylesRepo } from "./dal/index.ts";
import { parseAllocation } from "./dal/experiments.ts";
import { parseStyleConfig } from "./reply-strategy/rag-reply.ts";

/**
 * Загружает variants эксперимента: парсит allocation_json + резолвит каждый
 * style_slug через StylesRepo + StyleSchema.parse'ом. Невалидные/missing
 * стили skipпаются с warning'ом — эксперимент идёт на оставшихся.
 *
 * Возвращает null если ни одного валидного variant'а не осталось — caller
 * fall back'нет на default style (или DEFAULT_PERSONA если style тоже нет).
 */
export async function loadExperimentVariants(
  experiment: ExperimentRow,
  stylesRepo: StylesRepo,
): Promise<Array<{ style: Style; weight: number }> | null> {
  const entries = parseAllocation(experiment.allocationJson);
  const variants: Array<{ style: Style; weight: number }> = [];
  for (const entry of entries) {
    const row = await stylesRepo.findActiveBySlug(entry.styleSlug);
    if (!row) {
      console.warn(
        `[experiment-router] experiment=${experiment.slug}: style=${entry.styleSlug} not found, skipping`,
      );
      continue;
    }
    const style = parseStyleConfig(row.configJson);
    if (!style) {
      console.warn(
        `[experiment-router] experiment=${experiment.slug}: style=${entry.styleSlug} invalid config_json, skipping`,
      );
      continue;
    }
    variants.push({ style, weight: entry.weight });
  }
  if (variants.length === 0) return null;
  return variants;
}

