// Side-effect import: при загрузке модуля template регистрируется в
// глобальном реестре @chatman-media/verticals#defaultRegistry.

import { defaultRegistry } from "@chatman-media/verticals";
import { REAL_ESTATE_V1 } from "./template.ts";

defaultRegistry.register(REAL_ESTATE_V1);

export { REAL_ESTATE_FUNNEL_STAGES } from "./funnel-stages.ts";
export { REAL_ESTATE_INTAKE } from "./intake.ts";
export {
  investmentAdvisorRoi,
  luxuryConsultantSpin,
  REAL_ESTATE_STYLES,
  relocationSpecialist,
} from "./styles/index.ts";
export { REAL_ESTATE_V1 } from "./template.ts";
