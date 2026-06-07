import { defaultRegistry } from "@chatman-media/verticals";
import { MODELING_V1 } from "./template.ts";

defaultRegistry.register(MODELING_V1);

export { MODELING_FUNNEL_STAGES } from "./funnel-stages.ts";
export { MODELING_INTAKE, MODELING_INTAKE_COMPLETION, MODELING_INTAKE_INTRO } from "./intake.ts";
export { friendRecruiter, MODELING_STYLES, proDirector, warmScout } from "./styles/index.ts";
export { MODELING_V1 } from "./template.ts";
