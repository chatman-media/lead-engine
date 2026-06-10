# Roadmap

Последнее обновление: 2026-06-10.

> **Канон позиционирования: универсальная платформа.** Lead Engine — multi-tenant
> AI-фронт-офис для бизнеса в мессенджерах, под **любую вертикаль и любой набор
> вертикалей**: оператор описывает бизнес — AI собирает воронку (линейную или
> мульти-запросную сервис-деск) на универсальном костяке фаз
> `capture → qualify → offer → [clear] → [fulfill] → won/lost`.
> Вертикальные шаблоны — стартовые категории входа, не границы продукта.
> Детали: [`POSITIONING.md`](POSITIONING.md), [`VERTICALS.md`](VERTICALS.md),
> [`../engineering/AI_FUNNEL_BUILDER.md`](../engineering/AI_FUNNEL_BUILDER.md).
> История позиционирования (recruitment-first → exchange-моновертикаль →
> универсальная платформа) — [`../archive/ROADMAP_HISTORY.md`](../archive/ROADMAP_HISTORY.md).

Стратегический контекст — [`COMPETITORS.md`](COMPETITORS.md);
GTM-механика (шкала по месяцам, YouTube, питчи) — [`GTM_STRATEGY.md`](GTM_STRATEGY.md),
здесь её не дублируем.

---

## Где мы сейчас (июнь 2026)

Факты из кода:

- **9 vertical templates** (exchange · concierge · recruitment · modeling ·
  real_estate · saas · video · visa · scooter) на одном костяке фаз —
  карта и маппинг стадий в [`VERTICALS.md`](VERTICALS.md)
- **7 каналов**: Telegram bot + Telegram userbot (MTProto), WhatsApp, Facebook
  Messenger, VK, MAX, web-виджет — всё подключается из UI, per-tenant креды
- **AI-билдер воронок**: линейные и мульти-запросные (концерж/сервис-деск,
  один клиент ↔ N заявок) + поведенческий слой (стили, навыки, пер-стадийные
  goal/guidance, operator-handoff). Phase 2 поведенческого слоя завершён
- **Сервис-каталог + provider marketplace**: curated/custom providers, маршруты
  `funnel`/`partner_service`/`webhook`/`manual`, partner ledger и комиссии
- **Exchange-вертикаль live**: rate-card + guardrails, ops-алерты, KYC/реквизиты,
  exchange orders CRM, QR-выдача
- RAG v2 (multi-query + RRF, MMR, dynamic threshold, Jina/Cohere reranker),
  agentic tool-loop, admin copilot, informer-бот владельца, Quality Lab (первый срез),
  Stripe billing + тиры, superadmin, outreach, message templates, рефкоды
- **2400+ тестов**, ~500 admin/API-эндпоинтов, FORCE RLS + `withTenant`,
  encrypted secrets, CodeQL + Dependabot + Codecov
- **1 живой prod-tenant** (recruitment UAE), MRR ~$99

Полная PR-летопись сделанного —
[`../archive/ROADMAP_HISTORY.md`](../archive/ROADMAP_HISTORY.md).

**Узкое место — дистрибуция, а не функционал.** Деплой на домен ≈ неделя работы
и разблокирует продажи. Новые фичи до первых платящих клиентов — по остаточному
принципу.

### Ближайшие 30 дней (июнь 2026)

1. Задеплоить на Railway/Render + домен → первая публичная ссылка
2. Запустить демо-бот в Telegram (мета-демо: бот продаёт Lead Engine,
   [`../gtm/sales-bot/SETUP.md`](../gtm/sales-bot/SETUP.md))
3. 500 холодных DM (recruitment-wedge) в Telegram
4. 4 YouTube-видео (живые разрезы диалогов, UAE-кейс)
5. 10 питчей инвесторам в Telegram

### Активные эпики в коде

| Эпик | Статус |
|---|---|
| **Provider relay** — кросс-канальный брокер заказов (клиент в одном канале, провайдер в другом, платформа владеет заказом/оплатой/комиссией) — [`PROVIDER_RELAY_EPIC.md`](PROVIDER_RELAY_EPIC.md) | в работе (PR #469–471: provider order console, rollout observability) |
| **Coverage до 90%** (#187) | в работе, поэтапно по пакетам |
| **Quality Lab** (M15) | первый срез live; остатки — см. Q2'27 |
| Универсальные правила воронок из RE-тренинга (stage goal/CTA/SLA для всех seeds и AI-билдера) — [`REAL_ESTATE_TRAINING_FUNNEL_NOTES.md`](REAL_ESTATE_TRAINING_FUNNEL_NOTES.md) | заметки → бэклог |

---

## Цель: $1M ARR к декабрю 2026

$1M ARR = **$83K MRR**. Напрямую при $99–199/мес нужно 420–840 клиентов — solo
нереально за 7 месяцев. **Ключевой инсайт: мультипликаторы** — один
партнёр-агрегатор (отраслевая сеть, CRM-интегратор, франшиза) = 50–100 клиентов
одной сделкой.

| Трек | Механика | MRR-вклад к дек'26 |
|------|----------|---------------------|
| **Direct SMB** | Cold DM в Telegram (500/мес) + YouTube-воронка | ~$20K |
| **Партнёры-агрегаторы** | 5–10 отраслевых сетей × $2–5K/мес | ~$40K |
| **Pre-seed раунд** | $150–300K → 2 сейлза | разблокирует ×3 скорость |

### Фазы

| Фаза | Период | ICP | MRR target | Trigger |
|------|--------|-----|------------|---------|
| **Phase 1** | июнь–август 2026 | Wedge-вертикали: exchange (live) + recruitment RU/CIS/MENA + партнёры | $15–30K | deploy live |
| **Phase 2** | сент–ноябрь 2026 | + real estate + клиники; раунд закрыт | $50–85K | $15K MRR + 3 партнёра |
| **Phase 3** | дек'26–март'27 | Horizontal expansion + voice | $100K+ | $83K MRR = $1M ARR |

### Moat'ы

1. **Универсальный AI-билдер воронок** — «опиши бизнес → воронка», включая
   мульти-запросные сервис-деск воронки; конкуренты шипают чат-ответ, не процесс
2. **Sales-engine (SPIN + NEPQ + Cialdini)** — `@chatman-media/sales`,
   методологии как named skills
3. **Telegram-first** (bot + userbot) — доминирующий канал RU/CIS/MENA
4. **BYOK** — ARPU-sensitive клиенты со своим LLM-ключом
5. **Операционный контур, не «бот»** — operator handoff + сервис-каталог +
   provider marketplace + exchange orders CRM
6. **Partner/agency model** — рефкоды + white-label plan (Phase 2)

---

## Q3 2026 (Jun–Aug) — Deploy + Monetization 💰

Цель: довести продукт до точки **«платящий клиент №1»**.

M1–M5 закрыты (Stripe billing + тиры · WhatsApp UI · web-виджет · multi-admin ·
operator takeover), M9 (Telegram userbot) тоже — детали в
[`../archive/ROADMAP_HISTORY.md`](../archive/ROADMAP_HISTORY.md).

Открытые хвосты Q3:

- [ ] **Деплой на домен + демо-бот** — см. «Ближайшие 30 дней» (блокер продаж)
- [ ] Email-уведомления trial-ending / payment-failed (Resend уже подключён)
- [ ] Diagnostics-check для WhatsApp в `/diagnostics`
- [ ] CDN-hosting виджета (`cdn.leadengine.app`) — когда появится домен

### 🔲 M9-bis. Telegram Business Bot API

Официальный API (апр 2026) для бизнес-аккаунтов без Premium у пользователя;
предпочтительный онбординг новых tenants вместо MTProto userbot (userbot остаётся
для legacy).

- [ ] `channel-telegram` adapter: поддержка `business_connection_id` в webhook
- [ ] `sendMessage` с `business_connection_id` — ответ от имени бизнес-аккаунта
- [ ] UI: таб «Telegram (бизнес-аккаунт)» параллельно с userbot
- [ ] Bot-to-bot API для потенциального Managed Bot сценария

---

## Q4 2026 (Sep–Nov) — Vertical packs + agentic actions 🎯

Цель: дифференцироваться через **vertical packs** + движение вверх по autonomy
axis (см. [COMPETITORS §3](COMPETITORS.md)).

### M6. Следующие vertical packs

9 шаблонов уже в коде ([`VERTICALS.md`](VERTICALS.md)); очередь Prospect →
Implemented по приоритетам из карты ниш:

- [ ] `clinic_appointments_v1` / медицинский туризм — **Phase 2 вертикаль #2**:
  booking, insurance, pre-visit опросники; vision + OCR = максимальный
  технический дифференциатор
- [ ] `expat_insurance_v1` — высокий LTV, NEPQ-perfect, рынок не автоматизирован
- [ ] `diving_padi_v1` — медопросник + safety waiver = сильный дифференциатор
- [ ] `ecommerce_orders_v1` — order tracking, return policy, shipping
- [ ] `edtech_courses_v1` — course discovery, enrollment, support FAQ

Каждый pack: package `@chatman-media/vertical-*` + seed. Новые ниши без шаблона
закрываются AI-билдером — pack нужен там, где есть GTM-фокус.

### M7. Agentic actions (tool calls)

Tool-loop infra в `@chatman-media/kb` есть и wired; booking-link и exchange/concierge
domain-tools работают. Следующие инструменты:

- [ ] `crm.create_lead(name, phone, notes)` — internal leads table или
  outbound HTTP POST к Bitrix24 / AmoCRM (нужен для Phase 2 CIS)
- [ ] `calendar.book_slot(date, slotId)` — native slot-store (сейчас: pass-through ссылка)
- [ ] `payment.create_invoice(amount, currency)` — Stripe / YooKassa
- [ ] `notify.alert_operator(reason)` — escalation в Telegram-чат админов

### M8. Russia/CIS payments + CRM

Stripe не работает в РФ. Нужно для CIS market:

- [ ] YooKassa adapter (`payment-yookassa` package)
- [ ] CloudPayments adapter
- [ ] AmoCRM webhook + REST API integration
- [ ] Bitrix24 webhook + REST API integration

---

## Q1 2027 (Dec–Feb) — Scale + Compliance 🛡️

### M10. SOC 2 Type I + GDPR

Подготовка к B2B enterprise sales (см. [COMPETITORS §5](COMPETITORS.md) moat #5):

- [ ] Audit log retention policy + export (`GET /api/admin/audit-log/export.csv`)
- [ ] Tenant data export (`POST /api/admin/tenant/export` → S3 link)
- [ ] Tenant deletion (GDPR right-to-be-forgotten)
- [ ] DPA template + sub-processor list page
- [ ] Pen-test (внешний)
- [ ] Engage Vanta / Drata для SOC 2 Type I (3–6 месяцев)

### M11. Voice channel (Twilio + Vapi)

Voice — fastest-growing segment (19% deployments в 2025 vs 6% в 2023):

- [ ] `channel-voice` package — Twilio Voice adapter
- [ ] Vapi.ai integration для STT/TTS pipeline
- [ ] Webhook handler `/webhook/voice/:slug`
- [ ] Pipeline-агностичен: `Inbound { kind: 'voice', transcript }`

### M12. Self-host distribution (dual edition)

- [ ] **OSS edition** под AGPL-3.0 — core packages public; channels +
  enterprise features closed (или dual-license)
- [ ] **Self-host paid** ($24K+/year) — Docker compose + helm chart +
  SSO, advanced RBAC, SLA, dedicated support
- [ ] `apps/installer` — wizard для on-prem setup
- [ ] Vanta-acceptable security boundaries для on-prem audits

### M13. Per-channel pause + dynamic plans

Сейчас `tenant.status='suspended'` рубит все каналы:

- [ ] `channels.status='paused'` per-channel — toggle на каждой строке `/channels`
- [ ] Use-case: outage у LLM-провайдера → pause только AI-replies, operator reply
  через `/conversations` всё ещё работает

### M14. Per-user rate-limit + DB-backed quotas

In-memory rate-limiter уже работает per-tenant. Расширить:

- [ ] Per-user (externalUserId) sliding window — против одного abuser'а
- [ ] DB-backed quota counters для cross-process accuracy (Redis либо
  Postgres atomic UPDATE)
- [ ] Plan-aware limits (free=100/мес кап, pro=unlimited)

---

## Q2 2027 (Mar–May) — Agent quality + Marketplace

### M15. Agent QA (auto-grading replies)

Forethought выкатил Agent QA в Sep 2025, рынок будет требовать (см.
[COMPETITORS §7](COMPETITORS.md) trend #5).

**Status (2026-06):** первый срез Quality Lab live: `/quality` UI, self-play
checks, pairwise style comparisons, per-style ELO, coach proposals, shadow
evaluations, exchange answer-quality contracts, tool-call review с human
feedback labels.

Остатки:

- [ ] Production Agent QA dashboard: % escalation, avg time-to-resolve,
  sentiment drift, top fail-patterns
- [x] Close the tool-call feedback loop: aggregate wrong/missing/bad-args labels
  → coach/outcome analysis
- [ ] Shadow evaluations из API fire-and-forget → durable worker/job
  queue со stuck recovery
- [ ] Read-only manager access к Quality Lab (или явное обоснование superadmin-only)

### M16. Vertical marketplace 2.0 (paid templates)

- [ ] Open API для агентств / SI-партнёров публиковать vertical packs
- [ ] Revenue share 70/30 (publisher / platform)
- [ ] Examples: "Стоматологическая клиника" (RU/EN), "Salon booking" (FR),
  "Yoga studio" (US)

### M17. Multimodal — image понимание

Vision purpose уже в schema (`llm_provider_configs.purpose='vision'`) и
используется в KYC/photo-флоу. Расширение:

- [ ] processInbound для photo messages — vision model генерит описание
  → pipeline продолжает как text
- [ ] Use-case: клиент шлёт фото товара → bot опознаёт + retrieves KB

### M18. CRM 2.0 — Salesforce + HubSpot

После AmoCRM/Bitrix24 (M8) — выход на Western рынки:

- [ ] Salesforce Lightning adapter
- [ ] HubSpot adapter
- [ ] Notion integration (для KB sync)

---

## H2 2027 — Aspirational / parking lot

Слабее scoped, требует validation от первых клиентов:

- [ ] **Multi-region** деплой (EU / US / SEA) для data residency
- [ ] **Custom domain** per tenant (`*.leadengine.app` + CNAME `chat.yourbrand.com`)
- [ ] **Browser agent** (как Forethought Oct 2025) — bot заполняет формы
  на сайте от имени клиента
- [ ] **Outbound campaigns** — broadcast / drip / retention sequences
  (разовые broadcast'ы уже есть — `/outreach`)
- [ ] **Mobile admin app** (iOS / Android) — операторы отвечают с телефона
- [ ] **Sandbox env per tenant** — testing changes без impact на live
- [ ] **Plugins API** — публичный для custom tool-loop integrations

---

## Что НЕ делаем (отложено осознанно)

- ❌ **Real multi-region / sharding** — один Postgres до ~100 tenant'ов хватит
- ❌ **RLS policies для всех CRUDов** — `withTenant` + RLS как defense-in-depth
- ❌ **Custom domains** — subdomain `*.leadengine.app` достаточно до 100+ tenants
- ❌ **Apps/control-plane SPA** — superadmin role flag в admin-ui хватит
- ❌ **Event-sourcing / CQRS** — обычные CRUD + append-only `messages` +
  `audit_log` достаточно
- ❌ **Per-tenant Postgres database** — одна БД, `tenant_id` колонка
- ❌ **Marketplace verticals в БД** — hardcoded import packages до M16
- ❌ **Новые вертикали/фичи ради полноты** — до первых платящих клиентов
  приоритет у дистрибуции (деплой, демо, DM)

---

## Метрики прогресса

| Метрика | Сейчас (июнь'26) | Авг'26 | Ноябрь'26 | Дек'26 |
|---|---|---|---|---|
| Signup → first bot reply | < 5 мин self-serve ✅ | < 5 мин | < 3 мин | < 2 мин |
| Active tenants (direct) | 1 (recruitment-uae) | 50 | 200 | 350 |
| Partner deals | 0 | 3 | 8 | 10 |
| MRR | ~$99 | $15K | $70K | **$85K** |
| ARR | ~$1.2K | $180K | $840K | **$1M+** |
| Channel coverage | 7 (TG bot+userbot · WA · FB · VK · MAX · web) ✅ | + TG Business API | — | voice prep |
| Vertical templates | **9** | 9 | 10 (+clinic) | 11 |
| Tests | 2.4K+ | 2.6K+ | 3K+ | 3K+ |
| Compliance | none | none | none | SOC 2 in flight |
| Funding | bootstrap | pitch | raise closed | post-seed |

---

## Decision log (открытые вопросы)

1. **Дуальная лицензия (AGPL + commercial)?** — да к Q4 2026 (см. M12).
   Open-source как distribution channel + защита от копи-кэт'ов.
   Сейчас: PolyForm NC 1.0.0 + MIT для `packages/*`.
2. **Hosted region для пилотов** — EU (Frankfurt) для GDPR-готовности +
   RU/CIS клиенты через CloudFlare прокси.
3. **GTM-wedge для маркетинга** — exchange (live, Пхукет/ЮВА) + recruitment
   agencies UAE/CIS (текущий tenant); expand к real estate + клиникам (Phase 2).
   Каждый vertical pack (M6) = отдельная посадочная.
4. **Web widget brand** — нужно ли rebrand'ить от Lead Engine? Re-name к Q4'26
   после первых 5 paying customers.
5. **Voice partner** — Vapi vs Retell vs Bland.ai. Решение через 6 месяцев.
6. **OSS license** — AGPL-3.0 (forces SaaS rebuild) vs MIT (max adoption).
   Lean к AGPL — main moat это data + multi-tenant + Telegram-native, не код.

---

## Краткий summary

- **Канон:** универсальная платформа — любая вертикаль и набор вертикалей;
  AI-билдер воронок (линейные + мульти-запросные) на одном костяке фаз.
- **Срез возможностей:** см. «Где мы сейчас» выше + корневой
  [`README.md`](../../README.md); PR-летопись — в
  [`архиве`](../archive/ROADMAP_HISTORY.md).
- **Блокер продаж:** деплой на домен (≈ неделя). Всё остальное готово.
- **Путь к $1M ARR:** прямые клиенты ($99–199) + партнёры-агрегаторы
  ($2–5K/сделка) + pre-seed → сейлзы. 3 партнёра к августу, 10 к декабрю.
- **Q3'26:** деплой → первые клиенты. **Q4'26:** CRM tool-loop (AmoCRM/Bitrix24),
  TG Business Bot API, clinic pack. **Q1'27:** SOC 2, voice, self-host AGPL.
