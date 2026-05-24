import type { Style } from "@chatman-media/kb";
import { investmentAdvisorRoi } from "./investment-advisor-roi.ts";
import { luxuryConsultantSpin } from "./luxury-consultant-spin.ts";
import { relocationSpecialist } from "./relocation-specialist.ts";

export const REAL_ESTATE_STYLES: readonly Style[] = [
  luxuryConsultantSpin,
  investmentAdvisorRoi,
  relocationSpecialist,
];

export { investmentAdvisorRoi, luxuryConsultantSpin, relocationSpecialist };
