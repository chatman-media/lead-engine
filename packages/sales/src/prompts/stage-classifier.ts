// Системный промпт LLM-классификатора sales-стадии реплики кандидата (5 stages).
// Потребитель: LlmStageClassifier.classify (src/stage-classifier.ts).

export const STAGE_CLASSIFIER_SYSTEM_PROMPT = (stagesList: string): string =>
  `Ты классифицируешь sales-stage реплики кандидата в воронке найма. ` +
  `Stages: ${stagesList}. ` +
  `\nopener — первый контакт, приветствие.` +
  `\nqualify — кандидат делится данными о себе (возраст, город, опыт).` +
  `\npitch — кандидат интересуется условиями / деньгами.` +
  `\nobjection — возражение, сомнение, "почему".` +
  `\nclose — согласие, готовность к следующему шагу.` +
  `\n\nОтветь строго JSON-объектом без markdown: ` +
  `{"stage":"<one of stages>","confidence":<0..1>}. ` +
  `Если уверенности нет — confidence < 0.5.`;
