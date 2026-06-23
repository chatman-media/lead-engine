/**
 * Универсальный каталог навыков убеждения.
 * 25 техник, сгруппированных по семьям: Cialdini (7), Voss (5), NLP (3),
 * Sales (6), Custom (4).
 *
 * applicableStageKinds:
 *   ["intake"]  — rapport-техники (начало разговора)
 *   ["active"]  — техники убеждения (активная стадия)
 *   []          — always-on (применяются на любой стадии)
 *
 * Ported from sales-guru catalogue, promptFragment'ы на русском.
 */

export interface SkillCatalogueEntry {
  slug: string;
  family: "cialdini" | "voss" | "nlp" | "sales" | "custom";
  displayName: string;
  description: string;
  promptFragment: string;
  /** Пустой массив = применяется на всех стадиях */
  applicableStageKinds: string[];
  intent: string;
  isEnabled: boolean;
}

export const SKILLS_CATALOGUE: SkillCatalogueEntry[] = [
  // ── Cialdini (7) ──────────────────────────────────────────────────────────
  {
    slug: "social-proof-stat",
    family: "cialdini",
    displayName: "Социальное доказательство — статистика",
    description:
      "Упоминай конкретные цифры и факты о других клиентах, чтобы снизить воспринимаемый риск.",
    promptFragment:
      "Когда уместно — упомяни конкретное число: «Более 200 семей уже выбрали этот проект» или «87% наших клиентов закрывают сделку в первые 2 недели». Только реальные данные.",
    applicableStageKinds: ["active"],
    intent: "raise_trust",
    isEnabled: true,
  },
  {
    slug: "authority-badge",
    family: "cialdini",
    displayName: "Авторитет — регалии и экспертиза",
    description: "Ссылайся на экспертизу компании или партнёров, чтобы укрепить доверие.",
    promptFragment:
      "При сомнениях в надёжности — упомяни конкретный авторитетный факт: рейтинг застройщика, сертификаты, годы работы на рынке, партнёрство с известным брендом.",
    applicableStageKinds: ["active"],
    intent: "raise_trust",
    isEnabled: true,
  },
  {
    slug: "scarcity-units",
    family: "cialdini",
    displayName: "Дефицит — ограниченный остаток",
    description: "Честно сообщай об ограниченности предложения, чтобы ускорить решение.",
    promptFragment:
      "Если есть реальный дефицит — скажи об этом: «В этом квартале осталось 3 юнита по этой цене» или «Этот этаж разбирают первым». Не преувеличивай и не выдумывай.",
    applicableStageKinds: ["active"],
    intent: "create_urgency",
    isEnabled: true,
  },
  {
    slug: "urgency-deadline",
    family: "cialdini",
    displayName: "Срочность — дедлайн",
    description: "Подчёркивай реальные временные ограничения акции или сделки.",
    promptFragment:
      "Если есть реальный дедлайн — упомяни его конкретно: «Цена фиксируется до пятницы» или «Застройщик поднимает прайс с 1-го числа». Не придумывай дедлайны.",
    applicableStageKinds: ["active"],
    intent: "create_urgency",
    isEnabled: true,
  },
  {
    slug: "liking-common-ground",
    family: "cialdini",
    displayName: "Симпатия — общие точки",
    description: "Найди что-то общее с клиентом, чтобы установить раппорт.",
    promptFragment:
      "Найди и отметь вслух что-то общее с клиентом — схожие цели, опыт, предпочтения. «Вы тоже цените приватность — именно поэтому этот квартал идеален».",
    applicableStageKinds: ["intake"],
    intent: "build_rapport",
    isEnabled: true,
  },
  {
    slug: "commitment-small-yes",
    family: "cialdini",
    displayName: "Последовательность — micro-yes",
    description: "Получай маленькие согласия, которые ведут к большому решению.",
    promptFragment:
      "Задавай вопросы, на которые легко ответить «да»: «Вам важно, чтобы дети были рядом со школой?» → «Именно поэтому этот район...». Не задавай несколько micro-yes подряд — это выглядит манипулятивно.",
    applicableStageKinds: [],
    intent: "build_commitment",
    isEnabled: true,
  },
  {
    slug: "reciprocity-value-first",
    family: "cialdini",
    displayName: "Взаимность — ценность вперёд",
    description: "Дай клиенту полезную информацию или инсайт, не ожидая ничего взамен.",
    promptFragment:
      "Дай что-то ценное бесплатно: инсайт о районе, сравнение проектов, объяснение схемы платежей. Не требуй ничего взамен — взаимность сработает сама.",
    applicableStageKinds: ["intake"],
    intent: "build_rapport",
    isEnabled: true,
  },

  // ── Voss (5) ───────────────────────────────────────────────────────────────
  {
    slug: "tactical-empathy",
    family: "voss",
    displayName: "Тактическая эмпатия — назови эмоцию",
    description: "Назови вслух эмоцию клиента, чтобы он почувствовал понимание.",
    promptFragment:
      "Когда клиент напряжён или сомневается — назови его эмоцию вслух: «Звучит как вас беспокоит...» или «Похоже, это решение даётся непросто». Не спрашивай «Как вы себя чувствуете?» — это слабее.",
    applicableStageKinds: [],
    intent: "build_rapport",
    isEnabled: true,
  },
  {
    slug: "mirroring",
    family: "voss",
    displayName: "Зеркалирование — повтор ключевых слов",
    description: "Повторяй последние 2–3 слова клиента с вопросительной интонацией.",
    promptFragment:
      "Зеркаль ключевые слова клиента — повтори их конец фразы с вопросительной интонацией. Это побуждает его раскрыться глубже без давления. Используй редко — не в каждом сообщении.",
    applicableStageKinds: ["intake"],
    intent: "build_rapport",
    isEnabled: true,
  },
  {
    slug: "calibrated-questions",
    family: "voss",
    displayName: "Калиброванные вопросы — «Как» и «Что»",
    description: "Задавай открытые вопросы начиная с «Как» или «Что», а не «Почему».",
    promptFragment:
      "Используй «Как» и «Что» вместо «Почему». «Что для вас важнее всего в этом решении?» вместо «Почему вы ещё не решили?». «Почему» звучит обвинительно.",
    applicableStageKinds: [],
    intent: "gather_info",
    isEnabled: true,
  },
  {
    slug: "labeling-objection",
    family: "voss",
    displayName: "Лейблинг — обезвредь возражение",
    description: "Назови возражение клиента до того, как он его выскажет.",
    promptFragment:
      "Когда чувствуешь скрытое возражение — назови его первым: «Похоже, вас смущает вопрос с рассрочкой» или «Звучит как вы не уверены в застройщике». Это снижает защиту.",
    applicableStageKinds: ["active"],
    intent: "handle_objection",
    isEnabled: true,
  },
  {
    slug: "accusation-audit",
    family: "voss",
    displayName: "Аудит обвинений — предупреди критику",
    description: "Перечисли возможные негативные мысли клиента до того, как он их скажет.",
    promptFragment:
      "Перечисли вслух худшие опасения клиента: «Вы можете подумать, что я пытаюсь вас поторопить — это не так. Моя цель...». Это обезоруживает и строит доверие.",
    applicableStageKinds: ["active"],
    intent: "handle_objection",
    isEnabled: true,
  },

  // ── NLP (3) ────────────────────────────────────────────────────────────────
  {
    slug: "pacing-leading",
    family: "nlp",
    displayName: "Пейсинг-лидинг — подстройка и ведение",
    description: "Сначала подстройся под темп и язык клиента, затем мягко веди к решению.",
    promptFragment:
      "Подстраивайся под темп, тон и словарный запас клиента. Если он пишет коротко — отвечай коротко. Если развёрнуто — отвечай развёрнуто. После подстройки мягко ускоряй темп диалога к действию.",
    applicableStageKinds: ["intake"],
    intent: "build_rapport",
    isEnabled: true,
  },
  {
    slug: "future-pacing",
    family: "nlp",
    displayName: "Проекция в будущее",
    description: "Помоги клиенту представить себя уже с продуктом, используя «когда», а не «если».",
    promptFragment:
      "Говори «когда», а не «если»: «Когда вы будете жить здесь...» вместо «Если вы купите...». Помоги клиенту мысленно перенестись в будущее с продуктом. Описывай конкретные детали — вид из окна, утренний кофе на балконе.",
    applicableStageKinds: ["active"],
    intent: "raise_value_anchor",
    isEnabled: true,
  },
  {
    slug: "reframing",
    family: "nlp",
    displayName: "Рефрейминг — смена рамки",
    description: "Переформулируй возражение так, чтобы оно стало преимуществом.",
    promptFragment:
      "Переформулируй возражение через другую рамку: «Да, цена выше среднего — именно потому что у этого проекта X, Y и Z, которые защищают вашу инвестицию». Не спорь — переключай угол зрения.",
    applicableStageKinds: ["active"],
    intent: "handle_objection",
    isEnabled: true,
  },

  // ── Sales (6) ──────────────────────────────────────────────────────────────
  {
    slug: "anchoring-high",
    family: "sales",
    displayName: "Якорение — высокий первый якорь",
    description: "Называй высшую цену первой, чтобы сделать реальную цену выглядящей выгодней.",
    promptFragment:
      "Когда уместно — начни с верхнего диапазона или премиум-опции прежде чем показать основную цену. «Пентхаусы стартуют от 4M$ — но есть отличные варианты от 1.2M$».",
    applicableStageKinds: ["active"],
    intent: "raise_value_anchor",
    isEnabled: true,
  },
  {
    slug: "loss-aversion",
    family: "sales",
    displayName: "Избегание потерь",
    description: "Акцентируй что клиент теряет промедлив, а не что он выигрывает купив.",
    promptFragment:
      "Скажи что клиент рискует потерять, если не действует: «Эта цена уже не будет через месяц» или «Другие смотрят этот юнит прямо сейчас». Только правда — не манипуляция.",
    applicableStageKinds: ["active"],
    intent: "create_urgency",
    isEnabled: true,
  },
  {
    slug: "bridge-question",
    family: "sales",
    displayName: "Мостовой вопрос",
    description: "Задай вопрос, который переводит клиента от обсуждения к следующему шагу.",
    promptFragment:
      "Заверши блок информации мостовым вопросом, ведущим к действию: «Когда вам удобно посмотреть объект?» или «Что нужно, чтобы двигаться дальше?». Не задавай двух вопросов подряд.",
    applicableStageKinds: [],
    intent: "advance_deal",
    isEnabled: true,
  },
  {
    slug: "feel-felt-found",
    family: "sales",
    displayName: "Feel-Felt-Found — трёхшаговая обработка",
    description: "Классическая техника обработки возражений через эмпатию и опыт других.",
    promptFragment:
      "При возражении: «Понимаю, как вы себя чувствуете (feel). Многие наши клиенты думали так же (felt). Но потом обнаружили, что... (found)». Используй только когда возражение реально типичное.",
    applicableStageKinds: ["active"],
    intent: "handle_objection",
    isEnabled: true,
  },
  {
    slug: "honest-objection",
    family: "sales",
    displayName: "Честное возражение",
    description: "Попроси клиента назвать реальное возражение, если он уклоняется.",
    promptFragment:
      "Если клиент даёт уклончивые ответы — спроси напрямую: «Что останавливает вас прямо сейчас?» или «Есть ли что-то, о чём мы ещё не говорили, что важно для вашего решения?».",
    applicableStageKinds: [],
    intent: "gather_info",
    isEnabled: true,
  },
  {
    slug: "assumptive-close",
    family: "sales",
    displayName: "Предположительное закрытие",
    description: "Говори так, как будто решение уже принято, предлагая выбор деталей.",
    promptFragment:
      "Когда клиент явно заинтересован — переходи к деталям как к уже решённому: «Вам удобнее встретиться в офисе или на объекте?» вместо «Хотите посмотреть?». Только если сигналы готовности очевидны.",
    applicableStageKinds: ["active"],
    intent: "advance_deal",
    isEnabled: true,
  },

  // ── Custom (4) ────────────────────────────────────────────────────────────
  {
    slug: "value-stacking",
    family: "custom",
    displayName: "Стекирование ценности",
    description: "Перечисляй все включённые бонусы и выгоды перед называнием цены.",
    promptFragment:
      "Перед ценой перечисли всё что входит: «В эту цену включено X, Y, Z, плюс A и B в подарок — и всё это за...». Клиент должен почувствовать, что цена мала по сравнению с ценностью.",
    applicableStageKinds: ["active"],
    intent: "raise_value_anchor",
    isEnabled: true,
  },
  {
    slug: "risk-reversal",
    family: "custom",
    displayName: "Снятие риска",
    description: "Явно назови все гарантии и способы защиты клиента от риска.",
    promptFragment:
      "Назови конкретные гарантии: escrow, юридическое SPA, репутация застройщика, возможность resale. «Ваши деньги защищены X, Y, Z — риск минимален».",
    applicableStageKinds: ["active"],
    intent: "raise_trust",
    isEnabled: true,
  },
  {
    slug: "competitor-contrast",
    family: "custom",
    displayName: "Контраст с конкурентами",
    description: "Сравни предложение с конкурентами, показывая реальное преимущество.",
    promptFragment:
      "Если клиент упоминает другие варианты — честно сравни: «Да, у X цена ниже, но там нет Y и Z, что в долгосрочной перспективе означает...». Не критикуй конкурентов эмоционально.",
    applicableStageKinds: ["active"],
    intent: "handle_objection",
    isEnabled: true,
  },
  {
    slug: "testimonial-story",
    family: "custom",
    displayName: "История успеха клиента",
    description: "Расскажи реальную историю похожего клиента, который остался доволен.",
    promptFragment:
      "Поделись кейсом похожего клиента: «Один наш клиент из [город], тоже искал вариант для [цель], и вот что у него получилось...». История должна быть конкретной и правдивой.",
    applicableStageKinds: ["active"],
    intent: "raise_trust",
    isEnabled: true,
  },

  // ── Custom Exchange (1) ───────────────────────────────────────────────────
  {
    slug: "exchange-vip-upsell",
    family: "custom",
    displayName: "Обменник — апселл VIP-услуг (Трансфер/Коридор)",
    description: "Детекция даты прилёта и предложение трансфера или Зелёного коридора.",
    promptFragment:
      "Если клиент упоминает дату прилёта или говорит, что только собирается на Пхукет — обязательно предложи доп. услуги: «Вижу, вы скоро прилетаете! Можем организовать комфортный трансфер из аэропорта или Зелёный коридор (VIP-проход границы) — подсказать детали?»",
    applicableStageKinds: ["intake"],
    intent: "advance_deal",
    isEnabled: true,
  },
];
