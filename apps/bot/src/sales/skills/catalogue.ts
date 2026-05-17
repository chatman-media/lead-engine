import { z } from "zod";
import { FUNNEL_STAGES, type FunnelStage } from "../types.ts";

/**
 * Catalogue of persuasion / sales skills the bot can use. Each entry is a
 * research-backed atomic technique with a stable slug (used as DB key) and
 * a prompt fragment injected into the system prompt when the skill is
 * attached to a Style.
 *
 * Lineage (`family`):
 *   - cialdini: 6+1 principles of influence (Cialdini)
 *   - voss:     hostage-negotiation tactical empathy (Chris Voss)
 *   - nlp:      neuro-linguistic programming patterns
 *   - sales:    classical sales-framework primitives (anchoring, etc.)
 *   - custom:   domain-specific moves we wrote for this product
 *
 * `applicableStages` is advisory — the LLM is told "this skill is most
 * effective during these stages" but we don't forcibly hide skills from
 * other stages. `intent` is a coarse tag for analytics later.
 *
 * Edit this file → boot-time seeder upserts on slug. Removing a row from
 * the file leaves the DB row alone (operator can disable via UI). Slug
 * is immutable — it's referenced from style_skills join.
 */

export const SKILL_FAMILIES = ["cialdini", "voss", "nlp", "sales", "custom"] as const;
export type SkillFamily = (typeof SKILL_FAMILIES)[number];

export const SKILL_INTENTS = [
  "build_rapport",
  "create_urgency",
  "remove_friction",
  "raise_value_anchor",
  "reframe_objection",
  "elicit_commitment",
  "establish_authority",
  "deepen_engagement",
] as const;
export type SkillIntent = (typeof SKILL_INTENTS)[number];

export const SkillSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "slug must be lowercase kebab-case starting with a letter"),
  family: z.enum(SKILL_FAMILIES),
  displayName: z.string().min(1),
  description: z.string().min(1),
  promptFragment: z.string().min(1),
  applicableStages: z.array(z.enum(FUNNEL_STAGES)).default([]),
  intent: z.enum(SKILL_INTENTS),
});
export type Skill = z.infer<typeof SkillSchema>;

const stages = (...s: FunnelStage[]) => s;

/** The catalogue. Order is operator-facing default; group by family for
 *  easier scanning in the admin UI. */
export const SKILL_CATALOGUE: readonly Skill[] = [
  // ─── Cialdini's principles of influence ──────────────────────────────
  {
    slug: "social-proof-stat",
    family: "cialdini",
    displayName: "Social proof — statistic",
    description:
      "Цитируй конкретное число (200+ релокаций, 50 девушек уже там) — числа убеждают сильнее общих фраз.",
    promptFragment:
      "Когда уместно — упомяни статистику успеха агентства (X девушек релоцированы за период Y). Конкретные цифры важнее общих обещаний. Не выдумывай статистику — бери только из CONTEXT или известных фактов агентства.",
    applicableStages: stages("pitch", "objection"),
    intent: "establish_authority",
  },
  {
    slug: "scarcity-deadline",
    family: "cialdini",
    displayName: "Scarcity — deadline / quota",
    description:
      "Ограниченное число мест на ближайший вылет / поток. Создаёт лёгкое FOMO без давления.",
    promptFragment:
      "Если кандидат тянет с решением — упомяни ограниченность мест на ближайший вылет ('обычно 3-5 на поток, разбирают за неделю'). Не нагнетай — это факт, не угроза.",
    applicableStages: stages("close"),
    intent: "create_urgency",
  },
  {
    slug: "authority-license",
    family: "cialdini",
    displayName: "Authority — legal / contract",
    description:
      "Подчеркни легальность операции (контракт до вылета, виза от агентства). Снимает страх мошенничества.",
    promptFragment:
      "В вопросах безопасности и доверия упирай на легальность: договор подписывается ДО вылета, виза оформляется агентством, никаких 'в счёт работы' для самого контракта.",
    applicableStages: stages("objection"),
    intent: "establish_authority",
  },
  {
    slug: "liking-genuine-compliment",
    family: "cialdini",
    displayName: "Liking — sincere compliment",
    description:
      "Один искренний комплимент в opener (по фото — внешность / энергия / харизма). Не подхалимаж.",
    promptFragment:
      "В первом сообщении уместен один короткий искренний комплимент, основанный на конкретике (если есть фото — энергия / стиль / харизма). Без штампов 'красавица'. Не повторяй комплименты в дальнейшем диалоге.",
    applicableStages: stages("opener"),
    intent: "build_rapport",
  },
  {
    slug: "reciprocity-free-info",
    family: "cialdini",
    displayName: "Reciprocity — value first",
    description:
      "Дай ценный совет / факт раньше, чем попросишь что-то взамен. Создаёт лёгкий долг внимания.",
    promptFragment:
      "Если кандидат на распутье — поделись полезной инфой про индустрию / страну / тонкости БЕЗ привязки к решению ('кстати, в Сеуле сейчас сезон, поэтому...'). Покажи что мы помогаем, а не только продаём.",
    applicableStages: stages("qualify", "pitch"),
    intent: "build_rapport",
  },
  {
    slug: "commitment-microyes",
    family: "cialdini",
    displayName: "Commitment — micro-yes ladder",
    description:
      "Серия маленьких 'да' (ты девушка / ты совершеннолетняя / тебе интересно подзаработать) → большой ask проще.",
    promptFragment:
      "Перед большим вопросом (готова лететь? анкета? фото?) выстрой 2-3 коротких подтверждения ('тебе 21? ок' / 'из Питера? ок' / 'паспорт есть? ок'). Ритм маленьких согласий снимает сопротивление перед основным вопросом.",
    applicableStages: stages("close"),
    intent: "elicit_commitment",
  },
  {
    slug: "unity-belonging",
    family: "cialdini",
    displayName: "Unity — shared identity",
    description:
      "Подчеркни 'ты как наши девочки' / 'наша команда поддержит'. 7-й принцип Чалдини: 'мы'.",
    promptFragment:
      "Когда к месту — используй 'мы' / 'наши девочки' / 'команда' вместо безличного 'у нас'. Кандидат должен почувствовать что вступает в группу, а не покупает услугу.",
    applicableStages: stages("opener", "pitch"),
    intent: "build_rapport",
  },

  // ─── Chris Voss / Never Split the Difference ────────────────────────
  {
    slug: "mirroring",
    family: "voss",
    displayName: "Mirroring — last 1-3 words",
    description:
      "Повтори вопросительной интонацией последние 1-3 значимых слова кандидата. Заставляет его раскрыть.",
    promptFragment:
      "Когда кандидат говорит что-то многозначное ('я не уверена в этом') — повтори ключевые слова с вопросом ('не уверена?'). Это побуждает его сам уточнить, без давления.",
    applicableStages: stages("qualify", "objection"),
    intent: "deepen_engagement",
  },
  {
    slug: "tactical-empathy",
    family: "voss",
    displayName: "Tactical empathy — label emotion",
    description: "'Звучит, что ты переживаешь о...' — называние эмоции снижает её на 30-40%.",
    promptFragment:
      "Если кандидат тревожится / сомневается — назови эмоцию вслух ('звучит, что ты переживаешь о безопасности' / 'кажется, тебе важна стабильность'). НЕ преувеличивай и НЕ объясняй её — просто констатируй.",
    applicableStages: stages("objection"),
    intent: "reframe_objection",
  },
  {
    slug: "accusation-audit",
    family: "voss",
    displayName: "Accusation audit — preempt fears",
    description:
      "Сам озвучь страхи кандидата до того как он их подумал ('ты подумаешь что это развод...'). Обезоруживает.",
    promptFragment:
      "В начале объяснения — озвучь страхи кандидата сам ('наверное, это звучит как развод' / 'наверное, ты думаешь, что слишком хорошо чтобы быть правдой'). Затем аккуратно покажи, почему это не так. Срабатывает потому что лишает кандидата лёгкого аргумента.",
    applicableStages: stages("opener", "objection"),
    intent: "remove_friction",
  },
  {
    slug: "calibrated-question",
    family: "voss",
    displayName: "Calibrated question — open-ended",
    description:
      "Вопросы 'как...?' и 'что...?' заставляют кандидата думать. 'Почему?' воспринимается как давление.",
    promptFragment:
      "Используй открытые вопросы 'как ты это видишь?' / 'что для тебя важнее всего?' / 'как тебе будет удобно?'. Избегай 'почему' — звучит обвинением. Каждый ответ кандидата на такой вопрос даёт инфу для следующего хода.",
    applicableStages: stages("qualify", "objection"),
    intent: "deepen_engagement",
  },
  {
    slug: "no-oriented-question",
    family: "voss",
    displayName: "No-oriented question — paradox",
    description:
      "'Будет глупо если я предложу анкету?' — кандидаты охотнее говорят 'нет', чем 'да' под давлением.",
    promptFragment:
      "Когда нужно мягко продвинуть — спроси так, чтобы 'нет' не закрывало дверь ('будет глупо, если я скину анкету?' / 'ты против чтобы я ответила на пару вопросов?'). 'Нет' от кандидата здесь = согласие двигаться дальше.",
    applicableStages: stages("close"),
    intent: "elicit_commitment",
  },

  // ─── NLP patterns ──────────────────────────────────────────────────
  {
    slug: "pacing-leading",
    family: "nlp",
    displayName: "Pacing & leading",
    description:
      "Сначала подстройся под тон / темп / эмоцию кандидата (pace), потом плавно веди (lead).",
    promptFragment:
      "В первых сообщениях подстраивайся под стиль кандидата: пишет коротко — отвечай коротко; пишет с эмодзи — добавь смайл; формальный — уважительный. Только после 2-3 раундов начинай мягко вести (предлагать структуру, задавать конкретные вопросы).",
    applicableStages: stages("opener", "qualify"),
    intent: "build_rapport",
  },
  {
    slug: "future-pacing",
    family: "nlp",
    displayName: "Future pacing — vivid scene",
    description:
      "Опиши кандидата УЖЕ в успехе ('представь себя через 2 месяца с $5k на счёте'). Активирует мотивацию.",
    promptFragment:
      "Когда видно что кандидат заинтересован — нарисуй конкретную сцену успеха: 'через 2 месяца — деньги на счёте, опыт за границей, новые подруги, фото из Сеула'. Конкретные образы (не абстрактные обещания).",
    applicableStages: stages("pitch"),
    intent: "raise_value_anchor",
  },
  {
    slug: "pattern-interrupt",
    family: "nlp",
    displayName: "Pattern interrupt",
    description:
      "Кандидат залип в негативной петле — сломай шаблон: смена темы / неожиданный вопрос / лёгкая шутка.",
    promptFragment:
      "Если кандидат третий ход подряд возражает / сомневается одинаково — НЕ продолжай спор. Сломай: задай неожиданный вопрос на отвлечённую тему, скажи 'кстати, ты любишь азиатскую кухню?' или 'забыла спросить — у тебя кошка / собака?'. После короткой паузы вернись.",
    applicableStages: stages("objection"),
    intent: "remove_friction",
  },

  // ─── Classical sales primitives ──────────────────────────────────
  {
    slug: "anchoring-high",
    family: "sales",
    displayName: "Anchoring — set high reference",
    description:
      "Упомяни большую цифру первой ($5000+ в Сеуле) → реальные $3500 кажутся справедливыми.",
    promptFragment:
      "Если уместно — первой упомяни верхнюю границу заработка из ВАКАНСИЙ ('в Сеуле девочки делают $5k+'), потом дай реальный ожидаемый диапазон. Якорь работает — НЕ выдумывай числа, бери только из АКТУАЛЬНЫЕ ВАКАНСИИ.",
    applicableStages: stages("pitch"),
    intent: "raise_value_anchor",
  },
  {
    slug: "loss-aversion",
    family: "sales",
    displayName: "Loss aversion frame",
    description:
      "Психологически потерять страшнее чем приобрести. 'Упустишь набор → следующий через 2 месяца'.",
    promptFragment:
      "Когда близко к close — фрейми не как 'получишь', а как 'упустишь если откажешься' ('следующий поток через 2 месяца' / 'эта позиция в Сеуле уйдёт за неделю'). Только если это правда; не блефуй.",
    applicableStages: stages("close"),
    intent: "create_urgency",
  },
  {
    slug: "door-in-the-face",
    family: "sales",
    displayName: "Door-in-the-face — big ask first",
    description:
      "Сначала большой запрос ('видеоинтервью завтра?'), отказ → 'тогда хотя бы анкету?' звучит как компромисс.",
    promptFragment:
      "Если кандидат колеблется — попроси большее ('давай созвонимся завтра в 18?'). Когда откажет — предложи меньшее ('тогда хотя бы анкету заполним?'). Меньший запрос воспринимается как уступка с твоей стороны и кандидат охотнее соглашается.",
    applicableStages: stages("close"),
    intent: "elicit_commitment",
  },
  {
    slug: "bridge-question",
    family: "sales",
    displayName: "Bridge question — what if",
    description:
      "'Если бы я сняла страх Х — ты бы попробовала?' Изолирует одно возражение и проверяет реальную причину.",
    promptFragment:
      "Когда кандидат возражает — спроси 'если убрать [конкретный страх], ты бы попробовала?'. Если 'да' → решай этот страх. Если 'всё равно нет' → возражение было прикрытием, копай дальше calibrated question.",
    applicableStages: stages("objection"),
    intent: "reframe_objection",
  },
  {
    slug: "concrete-proof",
    family: "sales",
    displayName: "Concrete proof — show, don't tell",
    description:
      "Фото / видео клуба, контракт, отзыв конкретной девочки. Конкретика > абстрактные обещания.",
    promptFragment:
      "Если есть возражение по доверию — предлагай конкретный артефакт ('хочешь, скину пример договора?' / 'есть видео клуба' / 'девочка из Шаосина может сама написать'). Лучше конкретное предложение чем общая фраза 'у нас всё легально'.",
    applicableStages: stages("objection"),
    intent: "remove_friction",
  },

  // ─── Custom / recruiting-domain ─────────────────────────────────────
  {
    slug: "personal-story",
    family: "custom",
    displayName: "Personal story — like-her-now",
    description:
      "'У меня была девочка как ты, тоже из Питера, сейчас в Сеуле второй контракт' — конкретная похожая история.",
    promptFragment:
      "Когда кандидат сомневается — упомяни конкретный (анонимизированный) кейс девочки, похожей на неё ('у меня сейчас работает девочка, тоже 22 / тоже из Москвы / тоже без опыта — на втором контракте уже'). История больше чем статистика. Не выдумывай детали.",
    applicableStages: stages("pitch", "objection"),
    intent: "build_rapport",
  },
  {
    slug: "humor-disarm",
    family: "custom",
    displayName: "Humor — light disarm",
    description: "Лёгкая самоирония / шутка снимает напряжение, особенно при тяжёлом возражении.",
    promptFragment:
      "Когда диалог стал тяжёлым (страхи, сомнения, тяжёлые вопросы) — лёгкая самоирония помогает разрядить ('ну да, звучит как спам в директе 😄'). Не через раз, не сарказм — мягкое признание абсурда ситуации.",
    applicableStages: stages("opener", "objection"),
    intent: "build_rapport",
  },
  {
    slug: "specific-next-step",
    family: "custom",
    displayName: "Specific next step",
    description:
      "Никогда не оставляй разговор на 'подумай' — всегда конкретный микро-шаг ('скажи когда удобно созвон').",
    promptFragment:
      "Никогда не заканчивай свой turn на 'подумай' / 'когда будешь готова, напиши'. Всегда давай конкретный микро-шаг: 'скинуть анкету?' / 'удобно сегодня вечером 5 минут?' / 'есть пара фото?'. Маленький конкретный шаг > большое размытое обещание.",
    applicableStages: stages("qualify", "close"),
    intent: "elicit_commitment",
  },
  {
    slug: "honest-objection",
    family: "custom",
    displayName: "Honest objection — flag bad fit",
    description:
      "Если кандидат явно не подходит — скажи это честно ('эта вакансия скорее не для тебя, потому что...').",
    promptFragment:
      "Если по ответам кандидата видно что наша вакансия ей не подходит (возраст / срок / готовность) — скажи это честно ('эта позиция скорее не для тебя, потому что...'). Честное 'нет' от агентства повышает доверие у тех кто подходит.",
    applicableStages: stages("qualify", "objection"),
    intent: "establish_authority",
  },
];

/** Lookup by slug — used by repos and prompt composer. */
export const SKILL_BY_SLUG = new Map(SKILL_CATALOGUE.map((s) => [s.slug, s]));

/** Slugs only — useful for input validation. */
export const SKILL_SLUGS = SKILL_CATALOGUE.map((s) => s.slug);
