// Side-effect import: при загрузке модуля template регистрируется в
// глобальном реестре @chatman-media/verticals#defaultRegistry.

import { defaultRegistry } from "@chatman-media/verticals";
import { VIDEO_V1 } from "./template.ts";

defaultRegistry.register(VIDEO_V1);

export { VIDEO_FUNNEL_STAGES } from "./funnel-stages.ts";
export { VIDEO_INTAKE } from "./intake.ts";
export { businessPartnerSpin, creativeProducerAida, VIDEO_STYLES } from "./styles/index.ts";
export { VIDEO_V1 } from "./template.ts";
