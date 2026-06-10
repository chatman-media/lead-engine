// Литеральные текстовые фрагменты sales-style промпта: подписи хуков Чалдини и блербы фреймворков.
// Потребитель: src/prompt.ts → composeSystemPrompt().

export const PROMPT_HOOK_LABELS = {
  social_proof: "СОЦ. ДОКАЗАТЕЛЬСТВО",
  scarcity: "ДЕФИЦИТ",
  authority: "АВТОРИТЕТ",
  liking: "СИМПАТИЯ",
  reciprocity: "ВЗАИМНОСТЬ",
  commitment: "ОБЯЗАТЕЛЬСТВО",
} as const;

export const PROMPT_FRAMEWORK_BLURB = {
  AIDA: "Двигай разговор по AIDA: Attention → Interest → Desire → Action.",
  PAS: "Используй PAS: Problem → Agitate → Solve. Кратко, без воды.",
  SPIN: "Веди по SPIN: Situation → Problem → Implication → Need-payoff.",
  NEPQ: "NEPQ: задавай нейро-эмоциональные вопросы. Пусть prospect сам убедит себя.",
  straight_line:
    "Belfort Straight Line: веди prospect к 10/10 уверенности по продукту, продавцу и компании. Тон уверенный и заразительный.",
} as const;
