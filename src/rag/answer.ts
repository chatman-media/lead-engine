import { config } from "../config.ts";
import type { KbRepo, KbSearchHit } from "../db/repos/kb.ts";
import { composeSystemPrompt, type SkillForPrompt } from "../sales/prompt.ts";
import type { FunnelStage, Style } from "../sales/types.ts";
import type { ChatClient, ChatMessage } from "./chat.ts";
import type { EmbeddingClient } from "./embed.ts";
import { verifyAnswer } from "./reflect.ts";
import { rewriteQuery } from "./rewrite-query.ts";
import { applyStyleRules } from "./text-style-rules.ts";
import { classifyTopic } from "./topic-classifier.ts";

/** Sentinel returned when retrieval is empty (or LLM cannot answer from
 * CONTEXT alone). The webhook layer turns this into a polite stall
 * reply ("секунду, уточню…") and queues the chat for the admin. */
export const NO_CONTEXT_MARKER = "__NO_CONTEXT__";

export interface Persona {
  /** Display name used in chat ("Алина", "Менеджер ALINA", etc.). */
  name: string;
  /** "human" → poses as a real person; "assistant" → openly an AI helper. */
  role: "human" | "assistant";
  /** Optional company / agency name. */
  company?: string;
  /**
   * Fixed personal facts about the persona — bypasses RAG for direct personal
   * questions and injects into the system prompt as inviolable grounding.
   * Known keys: "city" (city name), "age" (plain number or "26 лет"),
   * "status" (full natural reply for relationship/marital questions),
   * "experience" (full natural reply for "how long working" questions).
   * Values for "city" and "age" are auto-wrapped into sentences; values for
   * "status" and "experience" are returned verbatim as the bot reply.
   */
  facts?: Record<string, string>;
}

/** Legacy RAG temperature when sales `style` is not used (`answerWithRag` without `style`). */
export function legacyRagSamplingTemperature(persona: Persona): number {
  const t = config.rag.chatTemperature;
  if (t !== undefined) return t;
  return persona.role === "human" ? 0.55 : 0.38;
}

const DEFAULT_PERSONA: Persona = {
  name: "Менеджер",
  role: "assistant",
  company: "",
};

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

/**
 * Builds the system prompt. Two flavors keyed off `persona.role`:
 *
 * - "human"     — model speaks as a real human manager. Hard rules against
 *                 outing itself as AI/bot/LLM. Tone: short, warm, conversational.
 * - "assistant" — explicit AI assistant of the company.
 *
 * In both modes the model is forbidden from inventing facts and MUST emit
 * the bare `NO_CONTEXT_MARKER` if the answer is not in CONTEXT.
 */
/**
 * Renders the conversation-summary block. Returns "" when summary is missing
 * or whitespace so the prompt isn't inflated by a useless heading.
 * Exported for the sales-style composer.
 */
export function renderSummaryBlock(summary?: string): string {
  if (!summary) return "";
  const trimmed = summary.trim();
  if (!trimmed) return "";
  return `ИЗ РАННЕЙ ПЕРЕПИСКИ (контекст уже обсуждённого, не повторяй буквально):\n${trimmed}`;
}

/**
 * Renders the user-facts memory block. Returns "" when empty so it doesn't
 * inflate the prompt with a meaningless heading. Exported for use by the
 * sales-style prompt composer.
 */
export function renderUserFactsBlock(userFacts?: Record<string, string>): string {
  if (!userFacts) return "";
  const entries = Object.entries(userFacts).filter(([, v]) => v.trim());
  if (entries.length === 0) return "";
  return (
    `ЗНАЕМ О КАНДИДАТЕ (из прошлых разговоров — НЕ переспрашивай):\n` +
    entries.map(([k, v]) => `- ${k}: ${v}`).join("\n")
  );
}

export function buildSystemPrompt(
  persona: Persona,
  context: string,
  userFacts?: Record<string, string>,
  conversationSummary?: string,
): string {
  const company = persona.company?.trim();
  const personaLine =
    persona.role === "human"
      ? `Тебя зовут ${persona.name}${company ? `, ты менеджер агентства ${company}` : ""}. ` +
        `Ты живой человек, работающий в переписке с кандидатом в Telegram. ` +
        `НИКОГДА не упоминай и не намекай, что ты ИИ, бот, ассистент, ` +
        `языковая модель, чат-бот, нейросеть, программа или система. ` +
        `НИКОГДА не пиши о себе в третьем лице, не говори про «оператора», ` +
        `«коллегу», «менеджера передаст», «свяжитесь с менеджером» — ты ` +
        `и есть тот самый менеджер, который ведёт диалог. ` +
        `Если кандидат прямо спрашивает «ты бот?» — отвечай уклончиво и ` +
        `по-живому ("конечно нет, я ${persona.name}, чем помочь?"), ` +
        `без оправданий. ` +
        `Пиши коротко, тепло и по-человечески, как в обычной переписке.`
      : `Тебя зовут ${persona.name}, ты ИИ-ассистент${company ? ` агентства ${company}` : ""}. ` +
        `Отвечай вежливо и по делу.`;

  const conversational =
    persona.role === "human"
      ? `\nЖИВАЯ РЕЧЬ (Telegram):\n` +
        `- Пиши так, чтобы это выглядело как переписка с реальным менеджером: естественные ` +
        `опорные слова, можно «поняла/ок», «если вкратце», «по контрактам у нас…» — ` +
        `без официоза («в соответствии с», «информирую Вас», «принято к сведению», ` +
        `«настоящим сообщением»).\n` +
        `- Связывай факты из CONTEXT связным текстом, а не как сухую выжимку из документа; ` +
        `цифры и условия оставляй точными как в CONTEXT.\n` +
        `- Не начинай с шаблонов вроде «Благодарю за вопрос» / «Отвечаю на ваш запрос». ` +
        `Можешь входить сразу в содержание.\n`
      : "";

  const rules =
    `СТРОГИЕ ПРАВИЛА:\n` +
    `1. Используй для фактов о вакансиях, условиях, странах и цифрах ТОЛЬКО ` +
    `секцию CONTEXT ниже. Если в CONTEXT есть информация по теме вопроса — ` +
    `обязательно ответь по сути, передай факты своими словами, дружелюбно и ` +
    `по-человечески. Не используй общие знания о мире, не сочиняй цифры, цены, ` +
    `сроки, города, названия стран, которых нет в CONTEXT. ` +
    `(Исключение: чисто персональный вопрос об имени/роли — см. п. 2a.)\n` +
    `2. Маркер "${NO_CONTEXT_MARKER}" верни РОВНО и БЕЗ каких-либо других ` +
    `слов в любом из этих случаев:\n` +
    `   - в CONTEXT нет фактов по теме вопроса;\n` +
    `   - в CONTEXT упоминается одна страна / город / локация / валюта, а ` +
    `вопрос про другую (например, в CONTEXT про Китай и юани, а спросили про ` +
    `Корею) — НЕЛЬЗЯ переносить факты с одной локации на другую;\n` +
    `   - в CONTEXT нужных конкретных цифр/условий нет, а вопрос требует ` +
    `именно их.\n` +
    `Если CONTEXT прямо отвечает на вопрос — отвечай по нему, не сваливайся ` +
    `на маркер.\n` +
    `2a. Если вопрос только о твоём имени или кто ты («как тебя зовут», «кто ты») — ответь ` +
    `по описанию в начале сообщения выше (имя, агентство). Никаких фактов о вакансиях ` +
    `от себя не добавляй. Маркер "${NO_CONTEXT_MARKER}" в этом случае НЕ используй.\n` +
    `3. Пиши ТОЛЬКО на русском языке, даже если вопрос задан на другом. ` +
    `Без префиксов вроде "Ответ:", "Согласно контексту", "Based on…", ` +
    `"<think>" и т.п. Никаких служебных тегов и рассуждений вслух.\n` +
    `4. Будь кратким — 1–5 предложений или короткий список из 2–4 пунктов, ` +
    `если перечисляешь. Без markdown-заголовков, без эмодзи-перебора. ` +
    `Стиль — живая переписка в мессенджере.\n` +
    `5. Не переспрашивай «что именно интересует / о чём расскажешь / ` +
    `уточни вопрос» — отвечай сразу по сути исходного вопроса по фактам ` +
    `из CONTEXT. Уточняющий встречный вопрос допустим только если без него ` +
    `ответ физически невозможен.`;

  const factsEntries = persona.facts
    ? Object.entries(persona.facts).filter(([, v]) => v.trim())
    : [];
  const factsBlock = factsEntries.length
    ? `\nЛИЧНЫЕ ФАКТЫ (используй строго эти данные, не изменяй):\n` +
      factsEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "";

  const userFactsBlock = renderUserFactsBlock(userFacts);
  const userFactsSection = userFactsBlock ? `\n\n${userFactsBlock}` : "";

  const summaryBlock = renderSummaryBlock(conversationSummary);
  const summarySection = summaryBlock ? `\n\n${summaryBlock}` : "";

  return `${personaLine}${conversational}${factsBlock}${summarySection}${userFactsSection}\n\n${rules}\n\nCONTEXT:\n${context}`;
}

export interface AnswerInput {
  question: string;
  kb: KbRepo;
  embedder: EmbeddingClient;
  chat: ChatClient;
  /** Recent dialog messages (oldest first), excluding the current question. */
  history?: ChatMessage[];
  topK?: number;
  /** Used to drop noisy hits; sqlite-vec returns L2 distance (lower=closer). */
  maxDistance?: number;
  /** Persona settings (see buildSystemPrompt). Optional — defaults to a
   *  generic AI-assistant persona for backward compatibility with tests.
   *  Mutually exclusive with `style`: when both are present, `style` wins. */
  persona?: Persona;
  /**
   * Sales style — when provided, the system prompt is composed via the sales
   * engine (`composeSystemPrompt`) instead of the legacy `buildSystemPrompt`.
   * `persona` is then ignored. See `src/sales/types.ts` for the schema and
   * `docs/SALES_STYLES.md` for the integration plan.
   */
  style?: Style;
  /**
   * Current funnel stage. Required when `style` is set; ignored otherwise.
   * Drives stage-specific guidance (opener vs pitch vs objection etc.) inside
   * the composed system prompt.
   */
  stage?: FunnelStage;
  /**
   * Whether to include the style's few-shot examples in the system prompt.
   * Default `true` (first turn). Pass `false` on follow-ups to save 200-500
   * tokens once the style anchor is already in chat history.
   */
  includeFewShot?: boolean;
  /** Optional output-token cap. When unset, the underlying ChatClient picks
   *  its own default (256 for Ollama). Useful for tests / playground to
   *  bound output time on slow CPU. */
  numPredict?: number;
  /**
   * Cross-session memory facts about the CANDIDATE (city, age, intent, …).
   * Survive conversation deletion (stored in users.profile_json.memory).
   * Injected into the system prompt as a "ЗНАЕМ О КАНДИДАТЕ" block so the
   * LLM doesn't re-ask things the candidate already told us in past sessions.
   */
  userFacts?: Record<string, string>;
  /**
   * When true, the question is passed through `rewriteQuery` before vector
   * retrieval. Resolves pronouns/elliptical follow-ups using `history`.
   * Adds one LLM call BEFORE retrieval (only when the heuristic flags the
   * question as ambiguous — typically ~20-30% of turns).
   */
  rewriteQueryBeforeRetrieval?: boolean;
  /**
   * When true, the generated answer is passed through `verifyAnswer` to
   * confirm every concrete fact it cites is present in the retrieved
   * context. Ungrounded answers are converted to NO_CONTEXT_MARKER (the
   * webhook then stays silent rather than send a hallucinated reply).
   * Adds one LLM call AFTER generation, only on turns that actually used
   * KB context (skipped for smalltalk/persona-fact short-circuits).
   */
  reflect?: boolean;
  /**
   * Hybrid retrieval: combine vector search and BM25 keyword search via
   * Reciprocal Rank Fusion. Catches exact-match queries (numbers, proper
   * nouns) that pure embedding search ranks poorly. No extra LLM calls —
   * just a second SQL query to the FTS5 index. When `maxDistance` is set
   * alongside this flag, it's IGNORED (fused ranks aren't on the L2 scale).
   */
  hybridSearch?: boolean;
  /**
   * Compressed summary of older turns (before the recent-history window).
   * Injected into the system prompt as "ИЗ РАННЕЙ ПЕРЕПИСКИ:" so the LLM
   * has continuity beyond the last 12 raw messages. Generated lazily by
   * the webhook (see runConversationSummaryRefresh) — caller just passes
   * whatever is currently stored.
   */
  conversationSummary?: string;
  /**
   * Topic-routed retrieval: when true and `classifyTopic(question)` returns
   * a deterministic match, only KB docs tagged with that topic (or untagged)
   * are searched. Falls back to global search when classifier returns null
   * OR the topic-filtered search yields zero hits — never reduces recall,
   * only sharpens precision when the classifier is confident.
   * Free at query time (regex classifier, no LLM).
   */
  topicRouting?: boolean;
  /**
   * Pre-rendered "АКТУАЛЬНЫЕ ВАКАНСИИ" block from admin-managed vacancies
   * (see VacanciesRepo + renderVacanciesBlock). Prepended to the KB context
   * so the bot answers from the freshest operator-curated info; KB hits
   * still appear below as background. Empty string = no active vacancies,
   * skip the heading.
   *
   * Important side effect: when set AND non-empty, retrieval may return
   * 0 KB hits and we still produce an answer (vacancies alone are enough
   * grounding). NO_CONTEXT_MARKER only fires when BOTH are empty.
   */
  vacanciesBlock?: string;
  /**
   * Persuasion skills attached to the active style. Loaded from the DB
   * (SkillsRepo.skillsForStyle) by the webhook and threaded through to
   * `composeSystemPrompt`. Filtered by current stage at compose time.
   */
  skills?: readonly SkillForPrompt[];
  /**
   * Books-priority retrieval: when true, searches the "books" topic first
   * (management / manipulation library). Falls back to global KB when the
   * books slice is empty. Pairs with `hybridSearch` — uses hybrid when both
   * flags are set, vector-only otherwise.
   */
  booksPriority?: boolean;
}

/**
 * Per-turn telemetry — captured for every `answerWithRag` call so the webhook
 * can persist it into `messages.meta_json` and admins can diagnose quality
 * regressions ("when did groundedness drop?", "is hybrid retrieval helping?")
 * without re-running the LLM. Fields are optional because not every turn
 * exercises every layer (smalltalk skips embed/retrieve, NO_CONTEXT skips
 * generation, reflection only fires on grounded turns).
 */
export interface AnswerTelemetry {
  /** "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok" */
  path: "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok";
  /** Number of milliseconds from `answerWithRag` entry to return. */
  total_ms?: number;
  /** Number of milliseconds spent in retrieval (embed + kb.search). */
  retrieval_ms?: number;
  /** Number of milliseconds spent in the main generator chat call. */
  generation_ms?: number;
  /** L2 distances (or fused ranks) of the top-k hits, in order. */
  top_distances?: number[];
  /** True when hybrid (BM25 + vector) was used instead of vector-only. */
  hybrid?: boolean;
  /** Topic the question was routed to ("visa", "payment", …) or null when
   *  classifier was inconclusive or topic filter fell back to global. */
  topic?: string | null;
  /** Original user question, when query was rewritten before retrieval. */
  original_query?: string;
  /** Rewritten search query, when different from `original_query`. */
  rewritten_query?: string;
  /** Reflection verdict (`grounded`) and reason, when reflection ran. */
  reflect?: { grounded: boolean; reason?: string };
}

export interface AnswerResult {
  text: string;
  usedChunkIds: number[];
  hits: KbSearchHit[];
  telemetry: AnswerTelemetry;
}

/** Shared: build a reply from pre-fetched hits. Called by both the
 *  books-priority path and the normal retrieval path to avoid duplication. */
async function answerFromHits(opts: {
  hits: KbSearchHit[];
  baseTelemetry: AnswerTelemetry;
  startedAt: number;
  input: AnswerInput;
  activePersona: Persona;
}): Promise<AnswerResult> {
  const { hits, baseTelemetry, startedAt, input, activePersona } = opts;
  const vacBlock = (input.vacanciesBlock ?? "").trim();

  if (hits.length === 0 && !vacBlock) {
    return {
      text: NO_CONTEXT_MARKER,
      usedChunkIds: [],
      hits: [],
      telemetry: { ...baseTelemetry, path: "no_context", total_ms: Date.now() - startedAt },
    };
  }

  const kbContextStr = hits
    .map((h, i) => `[#${i + 1}] (source: ${h.title})\n${h.text}`)
    .join("\n\n");

  const context = vacBlock
    ? kbContextStr
      ? `${vacBlock}\n\n${kbContextStr}`
      : vacBlock
    : kbContextStr;

  let systemPrompt: string;
  let temperature = legacyRagSamplingTemperature(activePersona);
  if (input.style) {
    const stage: FunnelStage = input.stage ?? "qualify";
    systemPrompt = composeSystemPrompt(input.style, stage, context, {
      includeFewShot: input.includeFewShot ?? true,
      ...(input.userFacts ? { userFacts: input.userFacts } : {}),
      ...(input.conversationSummary ? { conversationSummary: input.conversationSummary } : {}),
      ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
    });
    temperature = input.style.model.temperature;
  } else {
    systemPrompt = buildSystemPrompt(
      input.persona ?? DEFAULT_PERSONA,
      context,
      input.userFacts,
      input.conversationSummary,
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(input.history ?? []),
    { role: "user", content: input.question },
  ];

  const generationStart = Date.now();
  // Resolve numPredict (output token cap) in priority order:
  //   1. Explicit input.numPredict (tests / playground override)
  //   2. style.model.maxTokens (per-style author cap — was previously dead;
  //      bot's reply was truncated mid-sentence on multi-vacancy listings
  //      because Ollama's default 256 kicked in instead of the schema value)
  //   3. Ollama provider default (256)
  const numPredict = input.numPredict ?? input.style?.model.maxTokens;
  const raw = await input.chat.complete(messages, {
    temperature,
    ...(numPredict !== undefined ? { numPredict } : {}),
  });
  const text = sanitizeLlmOutput(raw);
  const generationMs = Date.now() - generationStart;

  const telemetry: AnswerTelemetry = { ...baseTelemetry, generation_ms: generationMs };

  if (input.reflect && text !== NO_CONTEXT_MARKER && text.trim().length > 0) {
    const verdict = await verifyAnswer({
      question: input.question,
      answer: text,
      context,
      chat: input.chat,
    });
    telemetry.reflect = verdict.grounded
      ? { grounded: true }
      : { grounded: false, ...(verdict.reason ? { reason: verdict.reason } : {}) };
    if (!verdict.grounded) {
      console.warn(
        `[reflect] dropping ungrounded answer: ${verdict.reason ?? "unknown"} | answer="${text.slice(0, 120)}"`,
      );
      return {
        text: NO_CONTEXT_MARKER,
        usedChunkIds: hits.map((h) => h.chunk_id),
        hits,
        telemetry: { ...telemetry, path: "ungrounded", total_ms: Date.now() - startedAt },
      };
    }
  }

  if (text === NO_CONTEXT_MARKER) {
    telemetry.path = "no_context";
  }

  return {
    text,
    usedChunkIds: hits.map((h) => h.chunk_id),
    hits,
    telemetry: { ...telemetry, total_ms: Date.now() - startedAt },
  };
}

export async function answerWithRag(input: AnswerInput): Promise<AnswerResult> {
  const startedAt = Date.now();
  const activePersona: Persona =
    input.style != null
      ? {
          name: input.style.persona.name,
          role: input.style.persona.role,
          ...(input.style.persona.company != null && input.style.persona.company.trim() !== ""
            ? { company: input.style.persona.company.trim() }
            : {}),
        }
      : (input.persona ?? DEFAULT_PERSONA);

  if (isPersonaSmalltalkQuestion(input.question)) {
    // Apply text-style rules (em-dash → hyphen, ellipsis → ..., etc) even
    // on the shortcut path: env-configured persona names/companies could
    // smuggle in unicode chars that the LLM-output sanitizer would catch.
    return {
      text: applyStyleRules(personaSmalltalkReply(activePersona)),
      usedChunkIds: [],
      hits: [],
      telemetry: { path: "smalltalk", total_ms: Date.now() - startedAt },
    };
  }

  // Bot/human/AI question — answer must agree with persona.role and not
  // parrot the system-prompt example. Same telemetry path as smalltalk —
  // no KB, no LLM call.
  if (isBotPresenceQuestion(input.question)) {
    return {
      text: applyStyleRules(botPresenceReply(activePersona)),
      usedChunkIds: [],
      hits: [],
      telemetry: { path: "smalltalk", total_ms: Date.now() - startedAt },
    };
  }

  const factKey = isPersonalFactQuestion(input.question);
  if (factKey) {
    const factReply = personaFactReply(activePersona, factKey);
    if (factReply) {
      return {
        text: applyStyleRules(factReply),
        usedChunkIds: [],
        hits: [],
        telemetry: { path: "persona_fact", total_ms: Date.now() - startedAt },
      };
    }
    // Fact not configured → fall through to RAG
  }

  const topK = input.topK ?? 5;

  // Optional query rewriting: resolve "а там?", "это сколько?" type follow-ups
  // into self-contained search queries so vector retrieval lands the right
  // KB chunks. The rewrite is used ONLY for embedding/retrieval — the
  // original `input.question` is still what the LLM answers, so the user's
  // exact phrasing remains in the prompt and conversation history.
  const searchQuery = input.rewriteQueryBeforeRetrieval
    ? await rewriteQuery({
        question: input.question,
        ...(input.history ? { history: input.history } : {}),
        chat: input.chat,
      })
    : input.question;

  const retrievalStart = Date.now();
  const [questionVec] = await input.embedder.embed([searchQuery]);
  if (!questionVec) throw new Error("Embedder returned no vector for question");

  // Books-priority mode: search the "books" topic first, fall back to
  // global KB when the books slice is empty. When both booksPriority and
  // hybridSearch are set, the priority search uses hybrid on each pass.
  if (input.booksPriority) {
    const allHits = input.kb.prioritySearch({
      embedding: questionVec,
      query: searchQuery,
      k: topK,
      vectorOnly: !input.hybridSearch,
    });
    const hits =
      input.hybridSearch || input.maxDistance === undefined
        ? allHits
        : allHits.filter((h) => h.distance <= input.maxDistance!);
    const retrievalMs = Date.now() - retrievalStart;
    const baseTelemetry: AnswerTelemetry = {
      path: "ok",
      retrieval_ms: retrievalMs,
      top_distances: hits.map((h) => Math.round(h.distance * 10000) / 10000),
      ...(input.hybridSearch ? { hybrid: true } : {}),
      ...(searchQuery !== input.question
        ? { original_query: input.question, rewritten_query: searchQuery }
        : {}),
    };
    return answerFromHits({ hits, baseTelemetry, startedAt, input, activePersona });
  }

  // Topic routing: classify the QUESTION (not the rewritten query — it
  // matches the cleaner regex anchors better). When the classifier is
  // confident AND the topic-filtered search yields hits, use those;
  // otherwise fall through to a global search. Never reduces recall.
  const topic = input.topicRouting ? classifyTopic(input.question) : null;

  // Hybrid retrieval (vector + BM25 + RRF) catches exact-match queries that
  // pure embedding search ranks poorly. When enabled, `maxDistance` is
  // skipped because the fused rank is on a different scale than L2 distance.
  const runSearch = (filterTopic: string | null) =>
    input.hybridSearch
      ? input.kb.hybridSearch({
          embedding: questionVec,
          query: searchQuery,
          k: topK,
          ...(filterTopic !== null ? { topic: filterTopic } : {}),
        })
      : input.kb.search(questionVec, topK, filterTopic);

  let allHits = runSearch(topic);
  let usedTopic: string | null = topic;
  if (topic !== null && allHits.length === 0) {
    // Topic filter starved retrieval — fall back to global. The miss is
    // either: classifier wrongly identified topic, OR no docs are tagged
    // with that topic yet. Either way, we'd rather return SOMETHING.
    allHits = runSearch(null);
    usedTopic = null;
  }
  const hits =
    input.hybridSearch || input.maxDistance === undefined
      ? allHits
      : allHits.filter((h) => h.distance <= input.maxDistance!);
  const retrievalMs = Date.now() - retrievalStart;

  // Telemetry common to every retrieval-based path. Distances are rounded to
  // 4 decimals to keep meta_json readable in admin dumps; precision past 4
  // decimals isn't useful for diagnosis.
  const baseTelemetry: AnswerTelemetry = {
    path: "ok",
    retrieval_ms: retrievalMs,
    top_distances: hits.map((h) => Math.round(h.distance * 10000) / 10000),
    ...(input.hybridSearch ? { hybrid: true } : {}),
    ...(input.topicRouting && topic !== null ? { topic: usedTopic } : {}),
    ...(searchQuery !== input.question
      ? { original_query: input.question, rewritten_query: searchQuery }
      : {}),
  };

  return answerFromHits({ hits, baseTelemetry, startedAt, input, activePersona });
}

/**
 * Strip artifacts some chat models emit despite system instructions:
 * - `<think>…</think>` reasoning blocks (qwen3, deepseek-r1 style).
 * - leading "Answer:" / "Ответ:" / "Согласно контексту" prefixes.
 * - surrounding whitespace.
 * - "AI tells" — em-/en-dashes, unicode ellipsis, "Конечно!" lead-ins
 *   (see `text-style-rules.ts` for the full list).
 *
 * Exported for unit tests.
 */
export function sanitizeLlmOutput(raw: string): string {
  let s = raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/^\s*<think\b[^>]*>[\s\S]*$/i, "");
  s = s.replace(/^\s*(?:answer|ответ|reply|response|согласно\s+контексту)\s*[:\-—]\s*/i, "");
  // Apply pluggable text-style rules (em-dash → hyphen, ellipsis → ..., etc).
  // See src/rag/text-style-rules.ts to add new rules without touching this file.
  s = applyStyleRules(s);
  return s.trim();
}
