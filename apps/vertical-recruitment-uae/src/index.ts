// Side-effect import: при загрузке модуля template регистрируется в
// глобальном реестре @chatman-media/verticals#defaultRegistry. Это позволяет
// conversation-engine при boot'е workers'а просто сделать `import
// "@chatman-media/vertical-recruitment-uae"` и тут же резолвить slug.

import { defaultRegistry } from "@chatman-media/verticals";
import { RECRUITMENT_UAE_V1 } from "./template.ts";

defaultRegistry.register(RECRUITMENT_UAE_V1);

export { RECRUITMENT_UAE_FUNNEL_STAGES } from "./funnel-stages.ts";
export {
  INTAKE_COMPLETION,
  INTAKE_INTRO_RU,
  RECRUITMENT_UAE_INTAKE,
} from "./intake.ts";
export { RECRUITMENT_UAE_V1 } from "./template.ts";
export {
  RECRUITMENT_UAE_VISA_INTERVIEW,
  VISA_INTERVIEW_DONE,
  VISA_INTERVIEW_INTRO,
} from "./visa-interview.ts";
