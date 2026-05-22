# Анализ конкурентов — lead-engine

Последнее обновление: 2026-05. Источники приведены инлайн; цены —
публичный прайс на момент исследования и могут меняться ежеквартально —
перепроверить перед использованием в pitch'ах.

## 1. Контекст

Мы строим **lead-engine** — multi-tenant SaaS, где бизнес:

1. Регается, подключает **свой** OpenAI / Anthropic API ключ (BYOK).
2. Подключает каналы: **Telegram first**, потом WhatsApp, web-виджет,
   позже IG / VK / Avito.
3. Грузит документы → RAG knowledge base.
4. AI отвечает на входящие лиды; **оператор** может перехватить
   диалог.

Целевые сегменты: SMB, edtech, рекрутинг-агентства, e-commerce саппорт,
недвижимость, телеком-ритейл, медклиники — любой бизнес с входящей
воронкой через мессенджеры. Geo-фокус: RU / CIS / MENA / SEA, где
Telegram доминирует, а западные инструменты его либо игнорируют, либо
относятся как к второстепенному каналу.

Рынок биполярен:

- **Топ-сегмент** ($100K–$1M ACV): Sierra, Decagon, Ada, Cognigy,
  Forethought — agent-платформы для F500.
- **Середина** ($30–$500/мес): Intercom Fin, Tidio Lyro, Crisp, Chatbase,
  CustomGPT — SaaS для SMB и mid-market.
- **Низ** ($0–$50/мес): ManyChat, Botpress free tier, OSS Rasa —
  flow-builder'ы, любители, маленькие маркетинговые команды.

lead-engine целится в средний сегмент с moat'ом, которого у него нет:
BYOK + Telegram-native + multi-tenant + operator-handoff + готовность
к open-source.

---

## 2. Таблица конкурентов

| # | Вендор | Тир | Что делают | Цена (2025–2026) | Целевой клиент | Наш differentiator |
|---|--------|-----|------------|------------------|----------------|--------------------|
| 1 | **Chatbase** | Mid (SMB) | Загрузка PDF / URL → виджет; 11M символов; AI Actions, хуки Stripe/Calendly/Zendesk. | Hobby $40, Standard $150, Pro $500/мес; доп. кредиты $12/1K | Solo-предприниматели, виджет для SaaS-лендинга | BYOK (они включают inference в цену), реальная поддержка Telegram, operator-handoff |
| 2 | **Sierra** | Enterprise | Voice + chat outcome-based агент для F500 ритейла / финтеха / телекома. $10B Series C в 2025, $15.8B Series E май 2026. | По договорённости — TCO 1-го года **$200K–$350K+**; outcome-based | F500 ритейл, финтех (SoFi, Ramp, Brex) | Мы не конкурируем; мы on-ramp до того, как они подпишут контракт Sierra |
| 3 | **Decagon** | Enterprise | "Концьерж"-агент для consumer-брендов. $250M Series D январь 2026, оценка $4.5B. Per-conversation / per-resolution тарификация. | По договорённости — шестизначные суммы | Notion, Duolingo, Affirm, Chime, авиалинии, телеком | То же что Sierra — aspirational tier выше |
| 4 | **Ada CX** | Enterprise | Omnichannel AI-агент поверх Zendesk/Salesforce. Resolution-based $1–$3.50/тикет. | От **$30K/год**, типичный $50K–$300K+ | CX-команды с 300K+ тикетов/год | Прозрачность цены, BYOK, Telegram-native |
| 5 | **Intercom Fin** | Mid-Enterprise | AI-агент-надстройка над helpdesk'ом Intercom. Per-resolution. | **$0.99 / resolution** + Intercom seat fee; минимум 50 resolution при external helpdesk | Существующие клиенты Intercom | Channel-agnostic, нет helpdesk lock-in, BYOK, Telegram |
| 6 | **Forethought** | Mid-Enterprise | Agentic multi-channel resolution + Agent QA + Browser Agents (окт 2025). | По договорённости — медианный ACV **~$56–60K/год** (Vendr) | Mid-market support-команды на Zendesk | Более дешёвый вход, Telegram, путь к self-host |
| 7 | **Ada (Tidio) Lyro** | Mid (SMB) | AI-агент Tidio для e-com; web-чат, email, Messenger, IG, WhatsApp. **Telegram отсутствует**. | Lyro от **$39/мес** на 100 диалогов; Tidio Starter $24/мес | Shopify-магазины, e-com SMB | **Telegram-first**, BYOK, multi-tenant agency mode |
| 8 | **Crisp + MagicReply** | Mid (SMB) | Omnichannel inbox с AI reply-suggester'ом. Каналы: WhatsApp, IG, Messenger, **Telegram**, SMS, Line, Viber, Discord. | Mini $45, Essentials $95, Plus $295, Unlimited $495/мес (flat за workspace) | EU SMB, multi-channel команды | Глубже RAG, BYOK, autonomous agent (Crisp — больше co-pilot) |
| 9 | **ManyChat** | Низ | Flow-builder для IG / Messenger / **Telegram** / WhatsApp / SMS маркетинга. AI — add-on $29/мес, "single-step response in flows". | Free; Pro $15+, растёт с числом контактов; AI add-on $29 | Инфлюенсеры / e-com маркетёры | Реальный RAG по документам, реальный operator-handoff, не marketing flow-tool |
| 10 | **Voiceflow** | Mid (Dev) | Visual builder для chat + voice агентов. Multi-LLM. Credit-based с апреля 2025. | Pro **$60/мес** + $50/editor; Business $150/мес; кредиты сверху | Conversation designers, девелоперы | Мы turn-key vertical (CX/leads); они — general-purpose builder |
| 11 | **Botpress** | Низ / Dev | Open-source + cloud agent-builder. $25M Series B 2025. | OSS бесплатно для self-host; Cloud Free $0; Plus $89; Team $495; Enterprise от ~$2K/мес + LLM | Девелоперы, агентства | Vertical продукт, не framework; быстрее до value для non-dev'ов |
| 12 | **CustomGPT.ai** | Mid (SMB) | Anti-hallucination RAG-бот; 1400 форматов документов, 92 языка. | Standard $99, Premium $499/мес | Knowledge-heavy SMB, multilingual документы | Покрытие каналов (они web-widget-first), operator inbox, Telegram |
| 13 | **Rasa Pro** | Enterprise / OSS | Open-source NLU framework + Rasa Pro / Studio. | OSS free; Rasa Pro от **~$35K/год** | Enterprise с in-house ML командой, регулируемые отрасли | Мы out-of-the-box SaaS; им нужна команда чтобы оперировать |
| 14 | **Cognigy** (теперь NICE Cognigy, поглощён в сент 2025 за ~$955M) | Enterprise | Conversational AI для контакт-центров, voice + chat. | От **$2.5K/мес** на входе; типичный ACV **$115K**, TCO $700K+ | F1000 контакт-центры, телеком, банкинг | Self-serve onboarding, BYOK, нет NICE/CXone lock-in |
| 15 | **Sendbird AI Agent** | Mid-Enterprise | Чат-инфра + AI-агент сверху; MAU-based. | Starter **$349/мес** на 5K MAU; Pro $499; Enterprise custom | Продукты с акцентом на in-app messaging | Vertical CX-продукт, не infra SDK; Telegram out of the box |
| 16 | **Helpshift** | Mid | In-app support + AI для mobile-first приложений. | Starter **$150/мес** на 250 issues; $0.45/extra issue | Mobile gaming, mobile-приложения | Multi-channel за пределами in-app; Telegram-native |
| 17 | **Help Scout AI Agent** | Mid | Email-first helpdesk с новым AI-агентом + AI resolutions. | Help Scout per-contact + AI **$0.75/resolution** | Email-heavy SMB | Messenger-first, real-time каналы, не email-центрик |
| 18 | **eesel AI** | Mid | "Wrapper" AI-агент поверх существующих helpdesk'ов (Zendesk, Freshdesk, Intercom). | От ~$49/мес до enterprise quote | Команды уже на helpdesk'е, хотят AI наверху | Мы replace, не augment; мы владеем каналом + operator UX |
| 19 | **OSS альтернативы**: LibreChat, AnythingLLM, Chatwoot + LLM-плагины, Typebot, Flowise | OSS | Self-host RAG / chat / flow builder. | Бесплатно | Девелоперы, privacy-conscious SMB | Turn-key SaaS + managed Telegram + tenant-isolation; OSS-юзеры — кандидаты на upgrade когда ops-расходы >$99/мес |

Финансирование Sierra: $350M Series C при $10B (сент 2025), $950M Series E при $15.8B (май 2026). Decagon: $131M Series C при $1.5B (июнь 2025), $250M Series D при $4.5B (январь 2026). Cognigy: поглощён NICE за ~$955M (сент 2025). Botpress: $25M Series B (2025).

---

## 3. Карта позиционирования

```
                     ВЫСОКАЯ АВТОНОМИЯ (агент действует)
                              ▲
                Sierra ●  ● Decagon
                              │
                        Ada ● │ ● Forethought
                              │ ● Cognigy
              Intercom Fin ● │
                              │   ● lead-engine (цель)
                  CustomGPT ● │ ● Chatbase
                  Lyro/Tidio ●│ ● Crisp MagicReply
                              │ ● Sendbird AI
                              │
                  Botpress ●  │ ● Voiceflow
                              │ ● Rasa
                              │
                   ManyChat ●─┴────────────────►
                              flow / co-pilot / suggestion
   ГОРИЗОНТАЛЬНЫЙ ◄───────────┼───────► VERTICAL / CX-СПЕЦИФИЧНЫЙ
                              ▼
                       НИЗКАЯ АВТОНОМИЯ
```

**В чём lead-engine выигрывает**

- Telegram-native (Sierra, Decagon, Ada, Lyro, Helpshift не считают
  Telegram first-class каналом).
- BYOK — клиент платит OpenAI / Anthropic напрямую, без наценки. Никто
  из Chatbase / Tidio / Intercom / Sierra так не делает; они включают
  inference в seat/resolution цену.
- Multi-tenant agency mode из коробки (один админ, много sub-tenant'ов,
  изолированные базы знаний) — полезно для маркетинговых агентств,
  рекрутинг-сетей, франшиз телеком-ритейла.
- Operator handoff first-class, а не отдельный $300/мес helpdesk SKU.
- Self-host / on-prem для регулируемых вертикалей (медклиники, банки,
  гос) — только Rasa и Botpress OSS на этом уровне, но им нужна ML-
  команда.

**В чём lead-engine проигрывает (сегодня)**

- Нет voice-канала (Sierra, Decagon, Cognigy, Forethought все шлют
  voice; voice — 19% объёма контакт-центров в 2026).
- Нет глубоких интеграций с Salesforce / Zendesk / HubSpot — enterprise
  не уйдёт с них.
- Нет Agent QA / scoring слоя как у Forethought.
- Нет SOC 2 / HIPAA / ISO сертификаций пока — table stakes для $100K+
  ACV.
- Меньший LLM-evaluation harness чем у Sierra / Decagon (они тюнят
  per-customer).

---

## 4. Pricing benchmarks (для нашего бизнес-плана)

| Тир | Якоря рынка | Типичный ACV / месяц | Что lead-engine должен брать |
|-----|-------------|----------------------|------------------------------|
| **Free / hobby** | Chatbase Free, Botpress Free, ManyChat Free | $0, ограничение ~100–1K msgs | Free: 1 tenant, 100 LLM-ответов/мес, только BYOK — funnel hook |
| **SMB Starter** | Chatbase Hobby $40, Tidio $24+, Lyro $39, Threado $49, Helpshift $150 | $30–$150/мес | **$49/мес**: 1 tenant, Telegram + 1 канал, 2K msgs, 1 оператор, BYOK |
| **SMB Growth** | Chatbase Standard $150, Crisp Essentials $95, Lyro $79–149, Tidio mid | $80–$200/мес | **$149/мес**: 3 канала, 10K msgs, 3 оператора, RAG до 50MB, agency mode preview |
| **Pro / agency** | Chatbase Pro $500, Crisp Plus/Unlimited $295–495, Botpress Team $495, Sendbird Starter $349 | $300–$700/мес | **$499/мес**: безлимит tenant'ов под одной org, 50K msgs, white-label, SLA |
| **Enterprise / self-host** | Rasa Pro $35K+/год, Cognigy $2.5K+/мес, Forethought $56K/год, Ada $30K+/год | $30K–$300K/год | **От $24K/год** за on-prem deployment + support; usage-тиры сверху |

Add-on логика повторяет рынок:

- LLM-токены — pass-through (BYOK) или +15% наценка если мы даём ключ
  как convenience SKU.
- Per-resolution upcharge (как Fin $0.99, Help Scout $0.75) только на
  Enterprise self-host тире, где outcome-based имеет смысл.
- WhatsApp conversation fees pass-through (Meta $0.02–$0.08 как у ManyChat).

Ключевой сигнал: клиенты middle-сегмента устали от непрозрачного
per-resolution pricing'а (повторяющийся pattern в Reddit-отзывах на
Ada / Fin / Decagon — "success makes your bill go up"). Flat-seat /
flat-msg cap с BYOK — чёткий positioning-wedge.

---

## 5. Матрица покрытия каналов

| Канал | lead-engine | Chatbase | Sierra | Decagon | Intercom Fin | Tidio Lyro | Crisp | ManyChat | Voiceflow | Botpress | CustomGPT | Forethought | Ada | Cognigy |
|-------|:-----------:|:--------:|:------:|:-------:|:------------:|:----------:|:-----:|:--------:|:---------:|:--------:|:---------:|:-----------:|:---:|:-------:|
| **Telegram** | ✅ first | partial | ❌ | ❌ | ❌ | **❌ (только через Zapier)** | ✅ | ✅ | через API | ✅ | ❌ | partial | ❌ | partial |
| Web widget | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| WhatsApp | ✅ | через API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | через API | ✅ | ❌ | ✅ | ✅ | ✅ |
| Instagram DM | ⏳ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Facebook Mess. | ⏳ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Voice | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | partial | ❌ | ✅ | ✅ | ✅ |
| Email | ⏳ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | partial | ❌ | ✅ | ✅ | ✅ |
| Slack / Discord | ⏳ | ✅ | ❌ | partial | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | partial | ✅ |
| VK / Avito / OK | ⏳ moat | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Telegram-провал реален.** Tidio требует Zapier для Telegram. Intercom
Fin его не имеет. Sierra / Decagon / Ada / Forethought игнорируют. У
Crisp и ManyChat он есть, но как один из многих — не как primary канал.
Для рынков где Telegram = SMS (RU, CIS, IR, UA, KZ, UZ, RS, BY, часть
MENA, Индонезия, Вьетнам) — это защищаемая ниша.

VK / Avito / OK — бонусный moat; ни один не-российский вендор такого
не отправит.

---

## 6. Что конкуренты не могут / не будут делать — наш moat

1. **BYOK как фича, не хак.** Sierra, Decagon, Intercom Fin, Chatbase,
   CustomGPT, Tidio все *включают* LLM-inference в seat/resolution
   тарифы с 30–80% маржой сверху. CX-команда за $20K/мес в Тбилиси или
   Эр-Рияде, у которой уже есть enterprise-контракт с Anthropic, не
   может его использовать на Intercom Fin. lead-engine позволяет — и
   это прямое сокращение ACV для клиента (часто 40–60% против $0.99
   за resolution у Fin).

2. **Data sovereignty / on-prem.** Sierra и Decagon — SaaS-only на AWS
   US/EU. Rasa Pro и Botpress OSS позволяют self-host, но требуют ML-
   команду. lead-engine как single-binary Docker-compose deployment для
   регулируемых вертикалей (частные клиники, банки, defense-подрядчики,
   госзакупки в не-US юрисдикциях) — реальный wedge.

3. **Telegram-first DX.** Все конкуренты, которые "поддерживают"
   Telegram, заставляют идти через Zapier, BotFather copy-paste или
   3-шаговый OAuth, который ломается на scale. У нас tenant подключён
   за <60 секунд.

4. **Multi-tenant из коробки.** Большинство платформ берут плату per
   workspace / per bot, что делает agency-перепродажу дорогой. У
   Botpress и ManyChat есть agency-тиры, но они marketing-flow-
   ориентированы. lead-engine может выпустить "marketing agency" план
   с 10–50 sub-tenant'ами под одним billing entity — рекрутинг-сети,
   edtech-франшизы, телеком-ритейл будут за это платить.

5. **Operator handoff как first-class объект**, а не $300/мес helpdesk
   bolt-on. Crisp это делает хорошо; Sierra и Decagon предполагают что
   агент полностью решает. Реальность для SMB — 60–80% AI + 20–40%
   человек, и UX handoff'а — место, где клиенты churn'ятся с Fin / Lyro.

6. **Open-source-ready ядро.** Public-source community edition (MIT /
   AGPL-ish) для core RAG + Telegram bot, с closed managed plane
   (billing, аналитика, hosted operator UI), даёт:
   - SEO / dev mindshare против Botpress, Rasa.
   - Доверие в privacy-conscious рынках (DACH, MENA госзакупки).
   - Бесплатный "downgrade" путь, который ловит клиентов, которые
     иначе ушли бы на OSS.

7. **Воронка лидов + sales-персоны встроены.** Sierra / Decagon
   фокусируются на *support*. Chatbase / CustomGPT — на *FAQ*. ManyChat
   — на *broadcast marketing*. lead-engine сидит на оси *inbound лид →
   квалификация → handoff* с persona-скриптами (recruitment intake,
   real-estate qualifier, edtech consultant) — vertical templates
   отгружаются в день 1. Ни один горизонтальный конкурент этого не
   делает без 4-недельной платной имплементации.

---

## 7. Тренды индустрии 2025–2026 — куда двигаться

1. **Outcome-based pricing побеждает**, но создаёт budget-anxiety.
   $0.99/resolution у Fin, $0.75 у Help Scout, $1–$3.50/тикет у Ada
   указывают направление. Наш ход: предложить как тир-3 опцию, лидить
   с предсказуемым flat-fee + BYOK для дифференциации.

2. **Vertical-агенты > горизонтальных платформ.** Industry-specific AI
   растёт на 36.5% CAGR против 18.9% для горизонтальных тулов (Google
   Cloud AI Agent Trends 2026). Vertical templates (recruitment intake,
   стоматологическая клиника, real-estate viewing, телеком SIM-swap
   support) будут ценнее, чем yet-another-builder. lead-engine должен
   отгрузить 5–8 vertical-пакетов в 2026.

3. **Voice идёт с niche на baseline.** 19% входящего трафика
   контакт-центров — voice-AI в 2026 против 6% в 2024. Sierra, Decagon,
   Cognigy, Voiceflow, Ada все voice-first или voice-equal. **Импликация
   для roadmap'а:** интегрировать ElevenLabs / Deepgram / OpenAI
   Realtime в H2 2026; предложить Telegram voice-сообщения →
   transcribe → reply как low-hanging fruit до полного PSTN.

4. **Мультимодальность — изображения + видео.** Multimodal — table
   stakes для любого 2026 RFP. Входящие фото (повреждения товара,
   загрузка документа, видео-аудишн танцовщицы для рекрутинга — наша
   собственная intake-skill уже это делает) должны быть first-class
   объектом, не "пересылаем attachment'ы оператору".

5. **Автономные workflow'ы / agentic actions.** У Chatbase есть "AI
   Actions" (Stripe, Calendly), у Forethought — Browser Agents, у Sierra
   — tool-use. Чтение и запись в CRM клиента (AmoCRM, Bitrix24 в RU;
   HubSpot, Salesforce в остальных) — следующая ось. lead-engine должен
   отгрузить небольшой "Actions" SDK в 2026 — Telegram-native бизнесы
   живут на AmoCRM / Bitrix24, и эти интеграции не оспариваются
   западными вендорами.

6. **Compliance и data residency.** EU AI Act, российский 152-ФЗ,
   саудовский NDMO, UAE DPL — все enforcement в 2025–2026. Self-host +
   region-pinned managed instances — must-have в 2026 для продаж
   mid-market'у в этих регионах.

7. **Agent QA / scoring как SKU.** Forethought, Ada, Sierra монетизируют
   "QA по 100% диалогов" отдельно. Мы должны отгрузить LLM-as-judge
   scoring (на полпути уже — self-play есть) как платный analytics-слой
   в Growth+.

8. **OSS-коммодитизация framework'а.** LibreChat, AnythingLLM, Chatwoot
   + LLM-плагины, Flowise, Typebot — слой "RAG + chat UI" быстро идёт
   к нулю. Защищённость уходит выше по стеку: vertical templates,
   channel-native UX, operator workflows, billing, compliance — везде,
   куда lead-engine должен ставить флаги.

---

## 8. Action items (инжиниринг и GTM)

1. **Отгрузить Telegram-first onboarding flow**, который попадает в
   "AI отвечает реальному лиду" за <5 минут — самая защищаемая
   демонстрация против Tidio / Intercom / Sierra в наших гео.
2. **BYOK billing UI** — явный pitch "ты подключаешь свой Anthropic
   ключ, мы берём $49 платформенной комиссии, всё". Поставить
   side-by-side калькулятор на маркетинг-сайте против $0.99 × N
   resolutions у Fin и bundled credits у Chatbase.
3. **5 vertical templates к EOY 2026**: recruitment intake (есть),
   стоматологическая клиника, real-estate qualifier, телеком SIM-swap,
   edtech course consultant. Каждый — 1 неделя работы и 10x marketing
   asset.
4. **Operator inbox-паритет с Crisp** — table stakes UX, который наши
   конкуренты gate'ят за $200+ helpdesk SKU.
5. **Public-source ядро** под AGPL к Q4 2026 — SEO play, dev-доверие,
   OSS-юзеры — upgrade pipeline.
6. **Интеграции AmoCRM + Bitrix24** — не оспариваются ни одним западным
   вендором на этой странице; привязывает нас к RU/CIS SMB.
7. **Compliance roadmap**: SOC 2 Type I к середине 2027, 152-ФЗ-
   совместимый RU hosting-партнёр, путь к ISO 27001. Без этого тир
   self-host $24K+/год не закроется.

---

## Источники

- [Chatbase Pricing](https://www.chatbase.co/pricing); [Chatbase review 2025 — eesel AI](https://www.eesel.ai/blog/chatbase)
- [Sierra Series C $10B — TheAIInsider](https://theaiinsider.tech/2025/09/05/sierra-announces-350m-in-funding-at-10b-valuation-to-expand-ai-customer-service-agents/); [Sierra pricing & alternatives — Lorikeet](https://www.lorikeetcx.ai/articles/sierra-ai-pricing-alternatives); [Sierra revenue & funding — Sacra](https://sacra.com/c/sierra/)
- [Decagon Series D $4.5B — BusinessWire](https://www.businesswire.com/news/home/20260128580542/en/Decagons-Valuation-Triples-to-$4.5-Billion-as-it-Ushers-in-the-Age-of-AI-Concierge); [Decagon equity research — Sacra](https://sacra.com/c/decagon/)
- [Intercom Fin pricing](https://fin.ai/pricing); [Fin per-resolution guide — eesel AI](https://www.eesel.ai/blog/intercom-fin-ai-pricing-per-resolution-2025)
- [Tidio Lyro pricing](https://www.tidio.com/pricing/); [Lyro pricing breakdown — eesel AI](https://www.eesel.ai/blog/lyro-ai-pricing)
- [Crisp pricing](https://crisp.chat/en/pricing/); [Crisp pricing guide — eesel AI](https://www.eesel.ai/blog/crisp-pricing)
- [ManyChat pricing](https://manychat.com/pricing); [ManyChat real costs — Flowgent](https://flowgent.ai/blog/manychat-pricing)
- [Voiceflow pricing](https://www.voiceflow.com/pricing); [Voiceflow pricing guide — eesel AI](https://www.eesel.ai/blog/voiceflow-pricing)
- [Botpress pricing](https://botpress.com/pricing); [Botpress pricing — eesel AI](https://www.eesel.ai/blog/botpress-pricing)
- [CustomGPT.ai pricing](https://customgpt.ai/pricing/)
- [Ada CX pricing — eesel AI](https://www.eesel.ai/blog/ada-cx-pricing)
- [Rasa pricing](https://rasa.com/pricing)
- [Cognigy pricing — Vendr](https://www.vendr.com/buyer-guides/cognigy-ai); [NICE acquires Cognigy — Crunchbase](https://www.crunchbase.com/organization/cognigy)
- [Forethought pricing — eesel AI](https://www.eesel.ai/blog/forethought-pricing)
- [Sendbird AI pricing — VideoSDK](https://www.videosdk.live/developer-hub/social/sendbird-pricing-comprehensive-guide)
- [Helpshift pricing — eesel AI](https://www.eesel.ai/blog/helpshift-pricing); [Help Scout AI pricing — eesel AI](https://www.eesel.ai/blog/helpscout-ai-resolutions-pricing)
- [Customer service trends 2026 — Robylon](https://www.robylon.ai/blog/11-customer-service-trends-2026); [AI agent trends 2026 — Google Cloud](https://cloud.google.com/resources/content/ai-agent-trends-2026); [Vertical AI Agents 2026 — ACTGSYS](https://actgsys.com/en/blog/vertical-ai-agents-industry-specific-2026)
- [Telegram CRM Eastern Europe context — Sinch](https://sinch.com/blog/telegram-bot-for-business/); [Telegram marketing stats 2026 — AffDude](https://affdude.com/telegram-marketing-statistics/)
- [BYOK trend — Surfmind](https://surfmind.ai/blog/byok-bring-your-own-key-future-of-ai-tools); [BYOKList directory](https://byoklist.com/)
