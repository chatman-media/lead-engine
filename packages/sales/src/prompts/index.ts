// Реестр промптов пакета (#516): все литеральные тексты промптов живут здесь; композиция остаётся в коде.

export { COACH_SYSTEM_PROMPT } from "./coach.ts";
export { JUDGE_SYSTEM_PROMPT } from "./judge.ts";
export {
  SELF_PLAY_DEFAULT_STALL_REPLY,
  SELF_PLAY_STALL_CTA_FALLBACK,
} from "./orchestrator.ts";
export { PAIRWISE_SYSTEM_PROMPT } from "./pairwise.ts";
export { PERSONA_SHARED_STYLE } from "./personas.ts";
export {
  FRAMEWORK_BLURB,
  HOOK_LABELS,
  kbGroundingReminder,
  supportBlock,
} from "./prompt.ts";
export { STAGE_CLASSIFIER_SYSTEM_PROMPT } from "./stage-classifier.ts";
