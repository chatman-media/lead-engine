import type { Persona } from "./answer-types.ts";

/**
 * True when the message is asking about the persona's nature (bot vs human
 * vs AI). Detected separately from the name/identity smalltalk because the
 * answer depends on `persona.role`, not just on `persona.name`. Returns a
 * single deterministic reply via `botPresenceReply` — bypassing RAG.
 *
 * Why this guard exists: the RAG system prompt contains an example reply
 * ("конечно нет, я ${name}, чем помочь?") meant for "ты бот?". Without this
 * shortcut, the LLM parrots that template literally — including for
 * "ты человек?", inverting the answer ("конечно нет" = "I'm not human").
 */
export function isBotPresenceQuestion(question: string): boolean {
  const trimmed = question.trim();
  if (!trimmed) return false;
  const q = trimmed.toLowerCase().replace(/\s+/g, " ");

  // Job/offer intent → not smalltalk; let RAG handle.
  const hasJobOrOfferIntent =
    /(работ|ваканс|зарплат|виза|оффер|переезд|агентств|услов|\bофис\b|график|смен|жилье|жильё|рейс|кита|китай|коре|англ\b)/i.test(
      question,
    );
  if (hasJobOrOfferIntent) return false;

  // One regex covering all forms: bare ("бот?", "человек?") and "ты <noun>"
  // ("ты бот", "ты chatgpt"). The leading "ты " is optional. Unicode-property
  // lookarounds replace `\b` because JS `\b` is ASCII-only and silently fails
  // on Cyrillic word ends — same trick as `isPersonaSmalltalkQuestion`.
  const presenceNouns =
    "бот|человек|робот|ии|нейросет(?:ь|ка)|нейронка|чат\\s*бот|chat\\s*bot|chat\\s*gpt|chatgpt|gpt|llm|ai";
  const ruRe = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:ты\\s+)?(?:${presenceNouns})(?![\\p{L}\\p{N}])`,
    "iu",
  );
  if (ruRe.test(q)) return true;
  return /(?<![a-z])are\s+you\s+(?:a\s+)?(?:bot|human|ai|robot)(?![a-z])/i.test(q);
}

/**
 * Deterministic reply for `isBotPresenceQuestion`. For role=human the bot
 * always asserts being human regardless of the question form ("ты бот?" /
 * "ты человек?" both → same human reply). For role=assistant it admits
 * being an AI helper.
 */
export function botPresenceReply(persona: Persona): string {
  const name = persona.name?.trim() || "Менеджер";
  if (persona.role === "human") {
    const company = persona.company?.trim();
    const tail = company ? `, в ${company}` : "";
    return `Я живой человек, ${name}${tail}. Чем помочь?`;
  }
  return `Я ${name}, ИИ-ассистент. Чем помочь?`;
}

/**
 * True when the message is only smalltalk about identity (name / who are you).
 * Catches the common bare forms candidates actually type — "как зовут?",
 * "имя?", "представься" — not just the textbook "как тебя зовут".
 *
 * Returns false when the message also has any work/offer intent — even
 * "как тебя зовут есть работа в китае?" should land in RAG, not the
 * smalltalk shortcut, because the candidate is asking about a job.
 */
export function isPersonaSmalltalkQuestion(question: string): boolean {
  const trimmed = question.trim();
  if (!trimmed) return false;
  const q = trimmed.toLowerCase().replace(/\s+/g, " ");

  const hasJobOrOfferIntent =
    /(работ|ваканс|зарплат|виза|оффер|переезд|агентств|услов|\bофис\b|график|смен|жилье|жильё|рейс|кита|китай|коре|англ\b)/i.test(
      question,
    );
  if (hasJobOrOfferIntent) return false;

  // Various phrasings of "what's your name". The bare forms ("как зовут?",
  // "имя?", "ваше имя") are the ones that USED TO LEAK into RAG and produce
  // an off-topic stall — the regression we just fixed.
  const nameCue =
    q.includes("как тебя зовут") ||
    q.includes("как вас зовут") ||
    q.includes("тебя как зовут") ||
    q.includes("вас как зовут") ||
    /^как\s+зовут\??$/.test(q) ||
    /как\s+(твоё|твое|ваше)\s+имя/i.test(question) ||
    /^(твоё|твое|ваше)\s+имя\??$/i.test(trimmed) ||
    /^имя\??$/.test(q) ||
    /как\s+звать/i.test(question) ||
    /как\s+(тебя|вас)\s+называть/i.test(question);

  // "представься" / "представься" / "представьтесь" — imperative forms of
  // "introduce yourself". Matches both the -ся and -сь endings (singular/plural).
  // Note: JS `\b` is ASCII-only and silently fails on Cyrillic word ends —
  // we use a Unicode-property lookahead instead. Same trick as stage-router.ts.
  const introCue =
    /^представ(ь|ьте)?(ся|сь)(?!\p{L})/iu.test(trimmed) ||
    /^представь(те)?\s+себя(?!\p{L})/iu.test(trimmed);

  const whoCue =
    /^кто\s+ты\??$/i.test(trimmed) ||
    /^ты\s+кто\??$/i.test(trimmed) ||
    /^кто\s+вы\??$/i.test(trimmed) ||
    /^с\s+кем\s+(я\s+)?(общаюсь|разговариваю|переписываюсь)\??$/i.test(trimmed);

  // English: "what's your name" / "what is your name" / "whats your name".
  // The earlier `what\s+('?s\s+)?your\s+name` required whitespace BEFORE 's,
  // which `what's` doesn't have — silent miss on the most common form.
  const enName = /\bwhat(?:'?s|\s+is)?\s+your\s+name\b/i.test(question);
  const enWho = /\bwho\s+are\s+you\b/i.test(question);

  return !!(nameCue || introCue || whoCue || enName || enWho);
}

/**
 * Returns a fact key ("city" | "age" | "status" | "experience") when the
 * question is ONLY about that personal attribute of the persona, or `null`
 * when it also contains job/offer intent (route to RAG in that case).
 *
 * Mirrors the `isPersonaSmalltalkQuestion` guard: same job-intent block list,
 * same design — pure function, no side effects, safe to call unconditionally.
 */
export function isPersonalFactQuestion(question: string): string | null {
  const trimmed = question.trim();
  if (!trimmed) return null;

  const hasJobOrOfferIntent =
    /(работ|ваканс|зарплат|виза|оффер|переезд|агентств|услов|\bофис\b|график|смен|жилье|жильё|рейс|кита|китай|коре|англ\b)/i.test(
      question,
    );
  if (hasJobOrOfferIntent) return null;

  const q = trimmed.toLowerCase().replace(/\s+/g, " ");

  const cityCue =
    /где\s+(ты\s+)?(живёшь|живешь)/i.test(q) ||
    /откуда\s+ты/i.test(q) ||
    /из\s+какого\s+города/i.test(q) ||
    /в\s+каком\s+городе/i.test(q) ||
    /где\s+(ты\s+)?сейчас/i.test(q) ||
    /где\s+(ты\s+)?находишься/i.test(q) ||
    /в\s+каком\s+месте/i.test(q);

  if (cityCue) return "city";

  const ageCue =
    /сколько\s+(тебе\s+)?лет/i.test(q) ||
    /тебе\s+сколько\s+лет/i.test(q) ||
    /какой\s+(у\s+тебя\s+)?возраст/i.test(q) ||
    /твой\s+возраст/i.test(q) ||
    /тебе\s+сколько/i.test(q) ||
    /^возраст\??$/.test(q);

  if (ageCue) return "age";

  const statusCue =
    /ты\s+замужем/i.test(q) ||
    /замужем\s+ты/i.test(q) ||
    /^замужем\??$/.test(q) ||
    /есть\s+(парень|муж|молодой\s+человек)/i.test(q) ||
    /в\s+отношениях/i.test(q) ||
    /одна\s+(живёшь|живешь)/i.test(q) ||
    /^ты\s+одна\??$/.test(q) ||
    /^отношения(\s+есть)?\??$/.test(q);

  if (statusCue) return "status";

  // Phone / contact requests. Common phrasings: "твой номер", "номер
  // телефона", "дай номер", "whatsapp есть?". Also catches the "+1 …"
  // / "+7 …" style request where a candidate asks where to message.
  const phoneCue =
    /(?<![\p{L}\p{N}])(номер\s+(твой|телефона|тел))/iu.test(q) ||
    /(?<![\p{L}\p{N}])(твой|какой|есть)\s+(номер|телефон|whatsapp|вотсап|whatsap)/iu.test(q) ||
    /(?<![\p{L}\p{N}])(дай|скинь|пришли)\s+(номер|телефон|whatsapp)/iu.test(q) ||
    /^номер\??$/.test(q) ||
    /^телефон\??$/.test(q) ||
    /^whatsapp\??$/i.test(q);

  if (phoneCue) return "phone";

  return null;
}

/**
 * Builds a short deterministic reply from `persona.facts[key]`.
 * Returns `null` when the fact is not configured (caller falls through to RAG).
 *
 * "city" / "age" values are wrapped in natural templates; "status" /
 * "experience" values are returned verbatim — the operator writes the full
 * natural reply for these (e.g. "Не замужем, работа всё время занимает").
 */
export function personaFactReply(persona: Persona, key: string): string | null {
  const val = persona.facts?.[key]?.trim();
  if (!val) return null;

  if (key === "city") return `Живу в ${val}.`;
  if (key === "age") {
    // If value already contains letters (e.g. "26 лет") return as-is, else append " лет"
    return /\d/.test(val) && !/[а-яё]/i.test(val) ? `${val} лет.` : `${val}.`;
  }
  if (key === "phone") {
    // The configured value is the raw number. Wrap with a natural
    // sentence so the bot doesn't sound like a database row.
    return `Мой номер: ${val}. Можно писать в WhatsApp / Telegram.`;
  }
  // "status" / "experience" / other — operator writes the full reply
  return val;
}

/**
 * Short tail phrases tacked onto the smalltalk introduction. Picked at
 * random per call so a candidate asking "как тебя зовут?" twice in a row
 * doesn't get a verbatim repeat — the giveaway "I'm a script" pattern.
 *
 * All entries use ASCII hyphens (not em-dashes); the smalltalk path
 * bypasses `sanitizeLlmOutput`, so anything here ends up in the wire
 * message exactly as written.
 */
const HUMAN_SMALLTALK_TAILS_WITH_COMPANY: readonly string[] = [
  "Что хотел узнать?",
  "По чему интересно?",
  "Чем помочь?",
  "Что подсказать?",
  "По работе что-то?",
  "", // sometimes just the introduction, no tail at all
];

const HUMAN_SMALLTALK_TAILS_NO_COMPANY: readonly string[] = [
  "Чем помочь?",
  "Что хотел узнать?",
  "Если что по вакансиям - просто напиши.",
  "",
];

function pickTail(pool: readonly string[]): string {
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? "";
}

/** Short reply derived from persona - no KB required. */
export function personaSmalltalkReply(persona: Persona): string {
  const name = persona.name?.trim() || "Менеджер";
  const company = persona.company?.trim();
  if (persona.role === "human") {
    if (company) {
      const tail = pickTail(HUMAN_SMALLTALK_TAILS_WITH_COMPANY);
      const head = `Меня зовут ${name}, я в ${company}.`;
      return tail ? `${head} ${tail}` : head;
    }
    const tail = pickTail(HUMAN_SMALLTALK_TAILS_NO_COMPANY);
    const head = `Меня зовут ${name}.`;
    return tail ? `${head} ${tail}` : head;
  }
  if (company) return `Я ${name}, помощник агентства ${company}.`;
  return `Я ${name}.`;
}
