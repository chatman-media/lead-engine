import type { Style } from "@chatman-media/kb";
import { efficientProcessor } from "./efficient-processor.ts";
import { expertConsultant } from "./expert-consultant.ts";
import { friendlyGuide } from "./friendly-guide.ts";

export const VISA_STYLES: readonly Style[] = [
  expertConsultant,
  friendlyGuide,
  efficientProcessor,
];

export { efficientProcessor, expertConsultant, friendlyGuide };
