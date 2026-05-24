// Side-effect import: при загрузке модуля template регистрируется в
// глобальном реестре @chatman-media/verticals#defaultRegistry.

import { defaultRegistry } from "@chatman-media/verticals";
import { SAAS_V1 } from "./template.ts";

defaultRegistry.register(SAAS_V1);

export { SAAS_FUNNEL_STAGES } from "./funnel-stages.ts";
export { SAAS_INTAKE } from "./intake.ts";
export { directCloserPas, productEvangelistSpin, SAAS_STYLES } from "./styles/index.ts";
export { SAAS_V1 } from "./template.ts";
