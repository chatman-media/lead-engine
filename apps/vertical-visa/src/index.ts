import { defaultRegistry } from "@chatman-media/verticals";
import { VISA_V1 } from "./template.ts";

defaultRegistry.register(VISA_V1);

export { VISA_FUNNEL_STAGES } from "./funnel-stages.ts";
export { VISA_INTAKE, VISA_INTAKE_COMPLETION, VISA_INTAKE_INTRO } from "./intake.ts";
export { efficientProcessor, expertConsultant, friendlyGuide, VISA_STYLES } from "./styles/index.ts";
export { VISA_V1 } from "./template.ts";
