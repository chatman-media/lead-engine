// Side-effect import: при загрузке модуля template регистрируется в
// глобальном реестре @chatman-media/verticals#defaultRegistry.

import { defaultRegistry } from "@chatman-media/verticals";
import { CONCIERGE_V1 } from "./template.ts";

defaultRegistry.register(CONCIERGE_V1);

export { CONCIERGE_FUNNEL_STAGES } from "./funnel-stages.ts";
export { CONCIERGE_INTAKE } from "./intake.ts";
export { CONCIERGE_STYLES, fastHelperAida, luxuryValetSpin } from "./styles/index.ts";
export { CONCIERGE_V1 } from "./template.ts";
