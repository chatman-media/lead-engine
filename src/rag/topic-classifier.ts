/**
 * Deterministic topic classifier for inbound questions in the recruitment
 * domain. Returns a topic slug (matching the values you tag KB docs with at
 * ingest time) or `null` when the question doesn't fall cleanly into one
 * bucket. No LLM call — pure regex over Russian + English with Unicode-
 * property word boundaries (JS `\b` is ASCII-only, fails silently on
 * Cyrillic; same trick used in stage-router.ts and rewrite-query.ts).
 *
 * Designed to be CONSERVATIVE: when in doubt, return null. The webhook
 * falls back to global retrieval on null, so a missed classification just
 * loses precision — not recall. Matching multiple topics also returns null
 * (mixed-intent question shouldn't be force-routed).
 *
 * Add new topics by appending to TOPIC_PATTERNS. The slug must match the
 * `topic` value used by your ingest pipeline (typically a directory name
 * under `kb/curated/<slug>/`).
 */
// Cyrillic-aware leading word-boundary lookbehind. Trailing word-boundary
// lookahead is intentionally OMITTED — patterns are STEMS that should match
// any inflected form ("зарплат" matches "зарплата" / "зарплате" / etc).
// False positives from inside other words are blocked by the leading
// lookbehind alone (e.g. "девиз" doesn't match the "виз" stem because the
// "е" before "виз" is \p{L}).
const NW = `(?<![\\p{L}\\p{N}])`;

const TOPIC_PATTERNS: Array<{ topic: string; pattern: RegExp }> = [
  {
    topic: "visa",
    // Виза, visa, оформление документов на въезд.
    pattern: new RegExp(`${NW}(виз|visa|загранпаспорт|invitation|приглашен)`, "iu"),
  },
  {
    topic: "payment",
    // Деньги: зарплата, оплата, ставка, комиссия, юани/евро/доллары.
    // "плат" is intentionally excluded as a bare stem — it's too generic
    // (matches "плата" / "платье" / "поплатишься"). Inflected verb forms
    // ("платят", "платить") are caught by the explicit list.
    pattern: new RegExp(
      `${NW}(зарплат|оплат|плат[ияеу]|ставк|комисси|юан|доллар|евро|рубл|salary|payment|rate)`,
      "iu",
    ),
  },
  {
    topic: "schedule",
    // График, смены, часы, выходные.
    pattern: new RegExp(`${NW}(график|смен|часов|выходн|расписан|schedule|shift)`, "iu"),
  },
  {
    topic: "housing",
    // Жильё, проживание, общежитие, квартира. Both Russian verb stems
    // "жил-" (past) and "жит-" (infinitive) are needed.
    pattern: new RegExp(`${NW}(жил|жит[ьея]|проживан|общежит|квартир|комнат|hous|accommod)`, "iu"),
  },
  {
    topic: "locations",
    // Конкретные локации в этом домене (Дубай, Стамбул, Китай, Корея).
    pattern: new RegExp(
      `${NW}(дуба|стамбул|кита|коре|шаохин|вэньчжоу|йиу|dubai|istanbul|china|korea)`,
      "iu",
    ),
  },
  {
    topic: "vacancy",
    // Прямые вопросы про офферы / "что у вас сейчас", виды клубов (KTV).
    // NOT triggered by location words alone — those go to "locations".
    pattern: new RegExp(
      `${NW}(ваканс|оффер|какие\\s+(есть|у\\s+вас)|что\\s+у\\s+вас\\s+(есть|сеичас|сейчас)|чем\\s+(можете|можно)|ktv|караоке\\s+хостес|хостес)`,
      "iu",
    ),
  },
  {
    topic: "requirements",
    // Требования к кандидату: рост, вес, возраст, опыт, фото/портфолио.
    pattern: new RegExp(
      `${NW}(рост|вес\\b|возраст|сколько\\s+лет|портфолио|фотосет|какие\\s+треб|нужно\\s+ли\\s+знать|опыт\\s+(работ|в))`,
      "iu",
    ),
  },
  {
    topic: "application",
    // Анкета, форма подачи / форма для, заявка, подать.
    pattern: new RegExp(`${NW}(анкет|форм[аыу]\\s+(подач|для)|заявк|подать|application)`, "iu"),
  },
];

/**
 * Returns a single topic slug when exactly ONE topic pattern matches, or
 * `null` when zero or multiple match. Multi-match is treated as ambiguous —
 * forcing one topic would silently drop docs from the other.
 */
export function classifyTopic(question: string): string | null {
  if (!question?.trim()) return null;
  const matches: string[] = [];
  for (const { topic, pattern } of TOPIC_PATTERNS) {
    if (pattern.test(question)) matches.push(topic);
  }
  if (matches.length === 1) return matches[0]!;
  return null;
}

/** Exposed for tests + admin debugging — lets callers see ALL matches. */
export function classifyTopicAll(question: string): string[] {
  if (!question?.trim()) return [];
  const matches: string[] = [];
  for (const { topic, pattern } of TOPIC_PATTERNS) {
    if (pattern.test(question)) matches.push(topic);
  }
  return matches;
}

/** All defined topic slugs. Useful for ingest CLI validation and admin UI. */
export const KNOWN_TOPICS: readonly string[] = TOPIC_PATTERNS.map((p) => p.topic);
