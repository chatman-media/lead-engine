import type { Style } from "@chatman-media/kb";
import { friendRecruiter } from "./friend-recruiter.ts";
import { proDirector } from "./pro-director.ts";
import { warmScout } from "./warm-scout.ts";

/**
 * Built-in sales-styles вертикали modeling. 3 production-curated стиля:
 *   - warmScout: тёплый скаут, SPIN, подходит для холодных лидов
 *   - proDirector: кастинг-директор, PAS, прямой и быстрый
 *   - friendRecruiter: NEPQ, эмоциональный, как подруга из индустрии
 */
export const MODELING_STYLES: readonly Style[] = [warmScout, proDirector, friendRecruiter];

export { friendRecruiter, proDirector, warmScout };
