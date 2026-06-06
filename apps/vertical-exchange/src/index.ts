// Side-effect import: при загрузке модуля template регистрируется в
// глобальном реестре @chatman-media/verticals#defaultRegistry.

import { defaultRegistry } from "@chatman-media/verticals";
import { EXCHANGE_V1 } from "./template.ts";

defaultRegistry.register(EXCHANGE_V1);

export { EXCHANGE_FUNNEL_STAGES } from "./funnel-stages.ts";
export { EXCHANGE_INTAKE } from "./intake.ts";
export { EXCHANGE_STYLES, fastTraderPas, vipConciergeSpin } from "./styles/index.ts";
export { EXCHANGE_V1 } from "./template.ts";
