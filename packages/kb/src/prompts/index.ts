// Реестр промптов пакета (#516): все литеральные тексты промптов живут здесь; композиция остаётся в коде.

export { EXTRACT_USER_FACTS_SYSTEM_PROMPT } from "./extract-user-facts.ts";
export {
  FACT_CHECKER_SYSTEM_PROMPT_NO_VACANCIES,
  FACT_CHECKER_SYSTEM_PROMPT_WITH_VACANCIES,
} from "./fact-checker.ts";
export { GRADE_SKILLS_SYSTEM } from "./grade-skills.ts";
export { MULTI_QUERY_SYSTEM_PROMPT } from "./multi-query.ts";
export { PROMPT_FRAMEWORK_BLURB, PROMPT_HOOK_LABELS } from "./prompt.ts";
export { REFLECT_SYSTEM_PROMPT } from "./reflect.ts";
export { REWRITE_QUERY_SYSTEM_PROMPT } from "./rewrite-query.ts";
export { SUMMARIZE_CONVERSATION_SYSTEM_PROMPT } from "./summarize-conversation.ts";
export { VISION_PASSPORT_PROMPT, VISION_SYSTEM_PROMPT } from "./vision.ts";
