import { defaultRegistry } from "@chatman-media/verticals";
import { SCOOTER_V1 } from "./template.ts";

defaultRegistry.register(SCOOTER_V1);

export { SCOOTER_FUNNEL_STAGES } from "./funnel-stages.ts";
export { SCOOTER_INTAKE, SCOOTER_INTAKE_COMPLETION, SCOOTER_INTAKE_INTRO } from "./intake.ts";
export { localBro, proRental, safetyFirst, SCOOTER_STYLES } from "./styles/index.ts";
export { SCOOTER_V1 } from "./template.ts";
