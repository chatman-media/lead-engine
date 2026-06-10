# Roadmap

Последнее обновление: 2026-06-06 — **Phase 2 поведенческий слой завершён + конвергенция концержа** (AI-билдер строит мульти-запросные воронки). Ранее: онбординг-рефактор + закрытая регистрация + универсальный костяк воронки (phase) + admin copilot + per-tenant креды каналов + CI-безопасность.

Стратегический контекст — см. [`COMPETITORS.md`](COMPETITORS.md), [`POSITIONING.md`](POSITIONING.md).

**TL;DR позиционирование (Phase 1):** Первый AI рекрутер с **Persuasion Engine**
для Telegram. Отвечает на входящих кандидатов за 30 секунд, ведёт по NEPQ-
методологии, не теряет лидов — передаёт рекрутеру только горячие анкеты.
BYOK, RU/CIS/MENA рынок, flat-fee $99/мес.

> **Pivot note (2026-06):** live-продукт развёрнут в моно-вертикаль **exchanges·agency**
> (обменники); recruitment остаётся как PoC-шаблон. Ядро платформы — **универсальная
> воронка, собираемая AI по описанию бизнеса**
> (см. [`../engineering/AI_FUNNEL_BUILDER.md`](../engineering/AI_FUNNEL_BUILDER.md)):
> любая вертикаль = инстанс одного костяка фаз. Recruitment-фрейм позиционирования ниже
> — Phase 1; будет переписан под exchange / мульти-вертикаль.

---

## Куда движемся: универсальная воронка как ядро

_2026-06-06._ Конвергенция концержа (R1–R5) доказала: **AI-сборщик воронки —
действительно универсальный**. Он строит не только линейные deal-пайплайны
(продажи / рекрутинг / обмен), но и **мульти-запросные сервис-деск воронки** (один
клиент ↔ N параллельных заявок), с пер-стадийным поведением бота и оператор-handoff'ом
как первоклассным конструктом. Разбор — [`../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md`](../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md).

**Что это меняет для рынка.** Адресуемый рынок расширяется с «линейные продажи / найм» на
**любой бизнес со структурированным intake → сервис-флоу**: консьерж, управление виллами,
expat-сервисы, клиники, мультисервисные точки. Онбординг таких — через тот же «опиши
бизнес → AI строит воронку», без кода.

**Три фронтира универсальной воронки:**
1. **Оператор-в-петле до конца** (R5-остаток): `/send-offer` завершает `awaiting_operator`-
   стадию + нотификация оператору → AI+человек ведут сервис-бизнес вместе.
2. **Первоклассная «заявка/тикет»** (R6) — если мульти-запрос станет ядром продукта.
3. **Агентные действия** (M7) и **вертикальные паки** (M6) теперь компонуются на одном
   универсальном хребте — не пять разрозненных вертикалей, а один движок.

---

## Цель: $1M ARR к декабрю 2026

Математика: $1M ARR = **$83K MRR**. При $99–$199/мес напрямую нужно 420–840
клиентов — solo нереально за 7 месяцев. **Ключевой инсайт: мультипликаторы.**
Один партнёр-агрегатор = 50–100 клиентов одной сделкой.

### Три параллельных трека

| Трек | Механика | MRR-вклад к дек'26 |
|------|----------|---------------------|
| **Direct SMB** | Cold DM в Telegram (500/мес) + YouTube-воронка | ~$20K |
| **Agency/партнёры** | 5–10 рекрутинговых сетей × $2–5K/мес | ~$40K |
| **Pre-seed раунд** | $150–300K → 2 сейлза | разблокирует ×3 скорость |

### GTM-шкала по месяцам

| Месяц | Фокус | MRR |
|-------|-------|-----|
| Июнь | Deploy + демо-бот. 500 DM. 5 клиентов. 4 YouTube-видео | $2K |
| Июль | Партнёрская программа (рефкоды). 20 клиентов | $5K |
| Август | Первый агрегатор-партнёр (50+ клиентов). Питч инвесторам | $15K |
| Сентябрь | Закрытие раунда. Найм 1-го сейлза | $30K |
| Октябрь | Сейлз × 3 к скорости. 3 партнёра | $50K |
| Ноябрь | Real estate вертикаль. Расширение | $70K |
| Декабрь | 5 партнёров + 200 прямых | **$85K → $1M ARR** |

### YouTube-стратегия (0-бюджет)

Не "обзор инструмента" — контент, который продаёт сам:
- **Формат А (вирусный):** Живой разрез диалога — бот ведёт кандидата по воронке,
  закрывает без оператора. Комментарий поверх: «здесь применяется NEPQ».
- **Формат Б (ROI-кейс):** «UAE-агентство закрывает 300 кандидатов/мес без
  операторов» — цифры из реального тенанта.
- **Формат В (конкурент-провокация):** «Почему ManyChat — это не продажи» +
  прямое сравнение. SEO + алгоритм.
- **Темп:** 2 видео/нед первые 2 мес. YouTube = доверие перед DM (конверсия ×3).

### Telegram-питч инвесторам

```
Telegram-первый AI-сейлз агент для рекрутинговых агентств.
$99/мес, BYOK, без кода. Кейс: UAE-агентство закрывает
300 кандидатов/мес без операторов. Ищем $200K на найм
двух сейлзов для захвата СНГ+MENA.
```

Целевые фонды: Fort Ross, Impulse VC, Cabra VC, 500 Global MENA.

---

## Стратегический план: Phase 1 → 2 → 3

| Фаза | Период | ICP | MRR target | Trigger |
|------|--------|-----|------------|---------|
| **Phase 1** | июнь–август 2026 | Recruitment agencies RU/CIS/MENA + партнёры | $15–30K | deploy live |
| **Phase 2** | сент–ноябрь 2026 | + Real estate + Dental/Clinic + раунд закрыт | $50–85K | $15K MRR + 3 партнёра |
| **Phase 3** | дек'26–март'27 | Horizontal expansion + voice | $100K+ | $83K MRR = $1M ARR |

### Phase 1 metrics (tracking)

| Метрика | Июнь | Июль | Август |
|---|---|---|---|
| Cold DMs | 500 | 500 | 500 |
| Demos | 10 | 20 | 30 |
| Paying customers (direct) | 5 | 20 | 50 |
| Partner deals | 0 | 1 | 3 |
| MRR | $2K | $5K | $15K |
| YouTube videos | 4 | 8 | 12 |
| Investor pitches | 5 | 15 | 25 |

### Phase 1 приоритетные moat'ы

1. **Recruitment-vertical expertise** — `recruitment_uae_v1` (прод) + `recruitment_generic` (новый)
2. **Sales-engine (SPIN + NEPQ + Cialdini)** — `@chatman-media/sales` + 3 Phase 1 skills
3. **Telegram-first** — RU/CIS/MENA доминирующий канал
4. **BYOK** — ARPU-sensitive агентства используют свой OpenAI ключ
5. **Operator handoff** — built-in inbox, не $300/мес add-on
6. **Partner/agency model** — реферальные коды + white-label plan (Phase 2)

---

---

## Done ✅ (что уже работает в проде)

### Foundation (этапы 1–7 из легаси-плана)

- ✅ Drizzle schema unification (tenant-scoped tables + FORCE RLS)
- ✅ Channel-core контракт + channel-telegram / channel-whatsapp / channel-facebook / channel-vk / channel-web adapters
- ✅ llm-router с per-tenant configs (OpenAI / OpenRouter / Anthropic / Ollama)
- ✅ conversation-engine pipeline (`processInbound` с 3-фазным tx split)
- ✅ `apps/api` + `apps/worker` процессы (out-of-process outbound)
- ✅ Multi-tenant ground (`tenant_id` + FORCE RLS + `withTenant`)
- ✅ Vertical templates registry (`recruitment_uae_v1` — реальный прод-tenant)

### SaaS self-service (PR #19–38, 16 PRs)

- ✅ **Auth** — HMAC-SHA256 stateless tokens, `bun.password` (argon2id)
- ✅ **KB upload UI** — multipart файлы + paste text, dedup по `content_hash`
- ✅ **Per-tenant LLM config CRUD** — encrypted apiKey в `tenant_secrets`
- ✅ **DB-driven LLM bootstrap** — `LoadedRef` + `InMemoryLlmRouter` per `(tenantId, purpose)`
- ✅ **Telegram channel onboarding** — paste token из BotFather + auto `getMe` validate + encrypt + insert
- ✅ **Auto-setWebhook** — POST channel сразу настраивает Telegram webhook на `<PLATFORM_PUBLIC_URL>/webhook/telegram/<slug>`
- ✅ **Onboarding checklist** — 3 шага с deep-link CTA, auto-hide когда done
- ✅ **Conversations inbox** — paginated list + thread, auto-poll 5s
- ✅ **Operator reply** — message с `role='human'`, `conversations.mode='human'`, outbound enqueue
- ✅ **Hot-reload в `apps/api`** — `tenant-reloader` + `LoadedRef` mutation + `router.invalidate`
- ✅ **Worker polling reload** — 30s interval, без рестартов
- ✅ **Audit log** — все admin-actions пишутся в `audit_log` (no raw secrets)
- ✅ **Tenant pause/resume** — `status='suspended'` → channels evict via reloadChannels
- ✅ **Diagnostics page** — health-check кнопка (channel + LLM + KB)
- ✅ **Inbound rate limiter** — sliding-window per tenant (60/min, 600/hour default)
- ✅ **Conversation mode toggle** (PR #35) — operator "Перехватить" → mode='human',
  AI замолкает; "Вернуть AI" → mode='ai'
- ✅ **WhatsApp channel onboarding via UI** (PR #36) — paste {phoneNumberId, accessToken}
  → Meta Graph validate (`getPhoneInfo`) → encrypt + webhook-setup-hint snippet
- ✅ **Plan tiers + quota** (PR #37) — free/starter/pro/enterprise с лимитами
  channels + KB docs + rate. POST channel/KB → 402 over-limit с upgradeHint
- ✅ **Stripe checkout + portal + webhook sync** (PR #38) — `POST /billing/checkout` →
  Stripe Checkout 14-day trial; `POST /billing/portal` → Customer Portal;
  webhook `customer.subscription.*` mutates `tenants.plan` по priceId map

### Reliability infra

- ✅ RLS-enforcement check на boot (warning если pod под BYPASSRLS role)
- ✅ Encrypted secrets (AES-256-GCM) + `getDecryptedSecret` / `setEncryptedSecret`
- ✅ Idempotency keys в `outbound_queue` (SKIP LOCKED, дедуп reply)
- ✅ Signature verification (Telegram secret-token, WhatsApp HMAC, Stripe HMAC)
- ✅ Anti-enumeration в whatsapp-webhook (signature check до tenant lookup)
- ✅ Observability — `PlatformMetrics` + `JsonLogger` + `makeMetricsSink`
- ✅ **950+ tests** across 15 packages (kb: 180; apps/api: 330+; sales: 116;
  conversation-engine: 59; channel-whatsapp: 17; observability: 16; worker: 15;
  storage: 15; channel-telegram: 11; channel-web: 11; llm-router: 9; verticals: 9;
  vertical-real-estate/saas/video: 3+3+3). 0 fail.

### Phase 1 prep (PR #39–44, май 2026)

- ✅ **Phase 1 pricing pivot** (PR #41) — Starter $49→**$99**, Pro $149→**$199**
  (recruitment-ICP ARPU $99–299; $49 был SMB-anchor Chatbase-уровня)
- ✅ **Multi-admin invite flow** (PR #42) — `POST /api/admin/admins/invite` →
  magic link email → `POST /api/auth/accept-invite` → join; role: manager/superadmin
- ✅ **Widget bundle** (PR #43) — `apps/widget` Vite ESM bundle < 50KB gzip;
  `GET /widget.js` served from api; tenant snippet через `/api/admin/widget/snippet`
- ✅ **Per-tenant LLM usage tracking** (PR #44) — `llm_usage_events` table;
  `LlmUsageWriter` batching flush; `GET /api/admin/billing/usage` endpoint;
  PlanWidget показывает calls/errors/latency за 30 дней
- ✅ **Recruitment skills (Phase 1)** — 3 новых skill: `qualify-budget-via-spin`,
  `objection-visa-cost`, `close-soft-deposit`; style `recruiter-empathetic-v1`

### GTM-инфраструктура (PR #87, #90, май 2026)

- ✅ **Партнёрские реферальные коды** — `referral_codes` таблица; `POST/GET/DELETE
  /api/admin/referral-codes`; signup принимает `referralCode` (best-effort tracking);
  страница «Партнёры» в admin-UI с генератором, копированием и счётчиком
- ✅ **Generic recruitment шаблон** — `recruitment_generic` в `SEED_TEMPLATES`:
  6 стадий (new_lead → qualifying → interview_scheduled → offer_sent → hired/rejected),
  без UAE/артистской специфики. Подходит для любого HR-агентства RU/CIS/MENA.
  Сид через `POST /api/admin/funnel/seed { template: "recruitment_generic" }`
- ✅ **«Закрыто ботом» метрика** — новая карточка на дашборде: сумма лидов в
  `terminal_won` стадиях. Ключевой ROI-показатель для удержания клиентов и YouTube-кейсов
- ✅ **Sales-бот (meta-демо)** — `leadengine_sales_v1` NEPQ-воронка для продажи
  Lead Engine рекрутёрам через Telegram. Полный KB-комплект: обзор продукта,
  кейс UAE, возражения/FAQ, сравнение конкурентов. System prompt «Алекс» с
  Cialdini-элементами. `docs/sales-bot/` — готово к деплою за 15 минут.
- ✅ **Agentic booking tool** — `makeBookingLinkTool` (RagTool): LLM сам
  вызывает инструмент когда лид просит записаться → отдаёт ссылку Calendly/Cal.com.
  Wired в `RagReplyStrategy` через `resolveTools()` с hot-invalidation кеша.
  UI `/settings/tools` для настройки booking URL. Хранится в `tenant_secrets`.

### GTM → production-ready (PR #118–123, май 2026)

- ✅ **Forgot-password / reset-password flow** — `password_resets` migration;
  `POST /api/auth/forgot-password` генерирует 64-hex токен + email через Resend;
  `POST /api/auth/reset-password` принимает токен, инвалидирует после использования;
  `POST /api/auth/change-password` (authenticated). UI: `/forgot-password` + `/reset-password?token=...`
- ✅ **Team invite email delivery** — `POST /api/admin/admins/invite` теперь
  отправляет magic-link email через Resend (было: URL возвращался в JSON без отправки)
- ✅ **Superadmin panel** — `GET /api/superadmin/tenants` (список всех тенантов со slug, plan,
  status, leadCount, conversationCount); `PATCH /api/superadmin/tenants/:id/plan`
  (ручная смена плана — скидки, trial extension). Role guard: 403 для manager.
  UI: `/superadmin` страница в admin-ui (только для superadmin)
- ✅ **KB quota enforcement** — `POST /api/admin/kb/documents` проверяет
  `count(kb_documents) ≥ PLAN_LIMITS[plan].kbDocs` → 402 с upgradeHint (было без проверки)
- ✅ **Message templates** — `GET/POST /api/admin/message-templates`,
  `PATCH/DELETE /api/admin/message-templates/:id`. CRUD с валидацией (пустое name/body → 400),
  cross-tenant isolation через RLS. UI на странице Outreach
- ✅ **Outreach broadcasts** — `POST /api/admin/outreach { text, leadIds|stageSlug, scheduledAt? }`.
  Для каждого лида ищет channel identity → enqueues в `outbound_queue`.
  Возвращает `{ enqueued, skipped, scheduledAt }`. UI на `/outreach`
- ✅ **Vertical templates x3** — `real_estate`, `saas`, `video` зарегистрированы
  в `SEED_TEMPLATES` и `defaultRegistry`. Каждый с funnel-стадиями, intake-анкетой, 2–3 стилями.
  Тесты: state-machine validity, intake stage linkage, required fields
- ✅ **950+ тестов** — auth forgot/reset, superadmin role guards, message-templates CRUD,
  outreach enqueued/skipped/stageSlug/scheduledAt — все integration tests против реального PG

### RAG v2 — retrieval quality (PR #122–123, май 2026)

- ✅ **MMR diversification** — `mmrDiversify()`: Maximal Marginal Relevance re-ranking
  после retrieval. Jaccard trigram similarity как прокси inter-chunk distance.
  `AnswerInput.mmr`, `mmrLambda`. Применяется в `answerWithRag` и `answerWithRagStream`
- ✅ **Dynamic distance threshold** — `applyDynamicThreshold()`: обрезает чанки с
  cosine distance > threshold (default 0.45). `AnswerInput.autoTrimDistance`, `autoTrimThreshold`
- ✅ **Multi-query expansion** — `expandQueries()`: LLM генерирует N перефразировок запроса,
  все эмбедятся в одном batch-вызове, поиск параллельно, результаты сливаются через RRF.
  `AnswerInput.multiQuery`, `multiQueryCount`. Покрывает синонимы и разные формулировки
- ✅ **RRF merge** — `rrfMerge()`: Reciprocal Rank Fusion для слияния N result lists.
  score = Σ 1/(k+rank), дедупликация по chunk_id, distance = 1/(1+score)
- ✅ **Jina / Cohere reranker** — `JinaReranker` + `CohereReranker` (cross-encoder)
  подключены в `AnswerInput.reranker`. Fetch candidateK=topK×3 → rerank → topK.
  Применяется во всех трёх retrieval-путях. Jina multilingual — работает с русским

### AI Workflow Builder + Exchange vertical (май 2026, PR #130)

- ✅ **AI Workflow Builder** — многоходовой диалог оператора с AI прямо в admin-UI.
  `POST /api/admin/workflows/ai-chat` ведёт диалог (до 60 ходов), AI задаёт уточняющие
  вопросы и генерирует preview воронки (стадии + поля). `POST /api/admin/workflows/apply`
  применяет к тенанту через `applyFunnelStages()`. Prompt caching на Anthropic API.
  Frontend: `AiWorkflowPanel` — Sheet-панель с историей чата, preview и "Применить".
  Кнопка "Настроить с AI" добавлена в `/funnel`.

- ✅ **Exchange вертикаль (`exchange_v1`)** — шаблон для обменных пунктов Пхукета:
  крипта (USDT/BTC/ETH) и RUB/EUR/USD → THB через офис, cardless ATM, курьера
  или перевод на тайский банк. Стадии: `exchange_request` → `quote_calculated`
  → `verification_check` → `kyc_collection` →
  `risk_review` → `order_created` → `requisites_sent` →
  `payment_proof_waiting` → `payment_verified` → `payout_or_completion`.
  Поля: asset/network/amount/payout_method, курс и THB,
  verification CRM id, risk decision, order id, реквизиты/TTL, чек или tx hash,
  source bank, final payout code/artifact.
  Двуязычный system prompt (RU/EN). Пакет `apps/vertical-exchange`,
  зарегистрирован в `KNOWN_TEMPLATES` и `SEED_TEMPLATES["exchange"]`.

- ✅ **QR/photo delivery из admin-UI (путь Б)** — `POST /api/admin/leads/:id/send-photo`
  принимает Telegram file_id или HTTPS URL, ставит outbound photo в очередь к клиенту.
  UI-блок "Отправить QR / фото клиенту" на странице лида. Основной кейс: оператор
  обменника генерирует cardless-withdrawal QR в банковском приложении (KBank/BBL)
  и отправляет клиенту через admin-UI без перехвата чата.

- ✅ **Exchange action layer + E2E mocks** — админка обменника управляет
  approved rate-card, формулами/отклонениями, реквизитами, заявками и оборотом.
  Tool-loop покрывает 10 редактированных exchange-сценариев: RUB QR/SBP, RUB card,
  USDT TRC20, Binance ID, KYC gate, receipt proof, courier/cardless ATM/Thai bank
  payout metadata. Route-level E2E покрывает auth, tenant isolation, operator patch
  и turnover без реальных банков/API.

- ✅ **`applyFunnelStages()` рефакторинг** — извлечена из `seedFunnelByKey` как
  shared helper; экспортированы `STAGE_KINDS`, `STAGE_TYPES`, `FIELD_TYPES`, `SeedStage`
  для использования в роутере AI workflow.

### UX + Telegram userbot (май 2026)

- ✅ **Guided onboarding wizard** (`/onboarding`) — после signup ведёт по шагам
  канал → API-ключи → база знаний → готово, с прогрессом и возобновлением.
  Чеклист и редирект после регистрации ведут в мастер. _(Переработан в июне
  2026 в обязательный gated vertical-aware визард — см. ниже.)_
- ✅ **Telegram userbot (личный аккаунт) — M9** — пошаговый MTProto-логин
  phone → code → 2FA (GramJS) с in-memory login-store; сессия encrypted в
  `tenant_secrets`. Userbot живёт в `apps/api` (как web): registry + inbound-runner
  (`receive → processInbound`) + outbound-dispatcher. UI: таб «Telegram (личный)» +
  re-auth при revoked-сессии. `apiId/apiHash` изначально из env; с июня 2026 —
  per-tenant в `tenant_secrets` с fallback на env (PR #160).
- ✅ **Admin-UI редизайн** — Tailwind v4 + shadcn/ui, Linear-эстетика
  (oklch-токены, индиго-акцент), левый сайдбар со всеми разделами,
  светлая/тёмная/системная темы. Все страницы переведены на shadcn.

### Онбординг-рефактор + костяк воронки + copilot (июнь 2026, PR #142–160)

- ✅ **Универсальный костяк воронки (`phase`)** (PR #160) — общая ось фаз
  `capture → qualify → offer → [clear] → [fulfill] → won/lost` поверх стадий
  всех 5 вертикалей. `stage_definitions.phase` (миграция `0031_stage_phase.sql`),
  `packages/verticals/src/phases.ts`, `validateBackbone()` (монотонность +
  обязательные qualify/offer), `GET /api/admin/funnel/phase-stats`. AI-builder
  и `apply` валидируют костяк (400 при нарушении).
- ✅ **Закрытая регистрация + gated онбординг** (PR #160) — публичный signup
  закрыт по умолчанию (`ALLOW_PUBLIC_SIGNUP=1` чтобы открыть), `/signup`
  страница убрана; tenant'ы — через invite. `OnboardingGate` форсит
  обязательный визард до разблокировки кабинета.
- ✅ **Динамический vertical-aware визард** (PR #160) — step-машина
  `vertical → channel → LLM → (обменник: rates → requisites → rate-card) →
  KB → (обменник: business data) → done`. Условие `done` зависит от вертикали
  (generic: канал+чат-LLM; обменник: + воронка + курс + реквизит). Сайдбар
  скрывает/показывает пункты по `isExchange`.
- ✅ **Per-tenant креды каналов** (PR #160) — Telegram MTProto
  (`api_id`/`api_hash`) и WhatsApp (`verify_token`/`app_secret`) теперь
  per-tenant в `tenant_secrets` с fallback на env. `/userbot/start` просит
  креды (400) вместо глобального 503. Userbot-подсистема always-on.
- ✅ **Embeddings auto-fit** (PR #160) — `fitDim()` подгоняет любую модель под
  колонку `vector(1536)` (truncate + L2-renormalize, Matryoshka). LLM-шаг
  визарда — accordion по всем purpose'ам (chat обязателен, остальные опц.).
- ✅ **Admin copilot (page-aware)** (PR #146, #148) — AI-ассистент-док на всех
  страницах кабинета (route + видимый контент), BYOK, advice + confirm перед
  применением действия (`install_vertical`/`build_funnel`/`navigate`).
  `POST /api/admin/copilot/chat`.
- ✅ **Надёжность курсов обменника + ops-алерты** (PR #142, #147) —
  guardrails котировок (отклонение > `maxDeviationPct`, дефолт 35%, в т.ч. для
  tier `display_rate`) + ops-watch sweeper (`rate_feed_stale`/`order_stuck`/
  `channel_down`/`volume_spike` → алерт владельцу с дедупом/cooldown).
- ✅ **CI-безопасность (бесплатно)** (PR #149–158) — CodeQL (security-extended,
  weekly), Dependabot (bun + GitHub Actions), Codecov upload + бейджи в README.
- ✅ **15 анонимизированных exchange-кейсов** (PR #159) — диалоги кандидатов
  в `apps/vertical-exchange/evals/exchange-candidate-cases/` вместо прежних сэмплов.

### Phase 2 behavior-слой + конвергенция концержа (июнь 2026, #195–#225)

- ✅ **Phase 2 поведенческий слой завершён** — AI генерит стиль (`/styles/generate-full`,
  #195), per-tenant активация стиля (#201), пер-стадийные `goal`/`guidance` на структурных
  стадиях + исполнение ботом (#208/#211), подбор навыков убеждения (#212).
- ✅ **AI-билдер строит мульти-запросные воронки** — консьерж/сервис-деск (один клиент ↔ N
  заявок по оси `request_type`): де-гейт через capability (#220), обучение билдера ветвлению,
  `request_type` + оператор-handoff (`awaiting_operator`) в рантайме (#225). Концерж стал
  «просто ещё одной AI-собираемой воронкой». Разбор —
  [`../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md`](../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md).

---

## Q3 2026 (Jun–Aug) — Monetization + Coverage 💰

Цель: довести продукт до точки **"платящий клиент №1"** + добавить
critical channel coverage.

### ✅ M1. Stripe billing wire-up — DONE (PR #37 M1a + PR #38 M1b + PR #41 re-price)

- ✅ Plan tiers: `free` (текущий self-host/exchange-focused режим с generous
  limits: 100 channels / 100K docs / 120 min), `starter` **$99/мес** (3/500/60),
  `pro` **$199/мес** (10/10K/120), `enterprise` (100/100K/600, self-host)
  _(re-priced PR #41: $49→$99, $149→$199 — recruitment ICP ARPU $99–299)_
- ✅ `POST /api/admin/billing/checkout` — создаёт Stripe Checkout Session
  (subscription mode + 14-day trial + `client_reference_id=tenantId`)
- ✅ `/webhook/stripe` обрабатывает `customer.subscription.*` events,
  mutates `tenants.plan` по `priceId → plan` map
- ✅ Plan enforcement: `canAddChannel` / `canAddKbDocument` в routes →
  402 с `{ reason, limit, current, plan, upgradeHint }`
- ✅ `POST /api/admin/billing/portal` — Stripe Customer Portal session
- ✅ Trial: 14 дней (через `subscription_data[trial_period_days]=14`)
- 🔲 **Plan-aware rate-limiter** — сейчас env-based default 60/min; full
  plan integration → DB-backed counters (M14, Q1'27)
- 🔲 **Email уведомления** trial-ending / payment-failed — TODO (нужна
  email-infra: SES / Resend integration)

### ✅ M2. WhatsApp channel UI — DONE (PR #36)

- ✅ UI `/channels` → tab "WhatsApp" → form {phoneNumberId, accessToken,
  businessAccountId?}
- ✅ Encrypt token (AES-256-GCM), insert `channels(kind='whatsapp')`
- ✅ Meta webhook setup: UI после create показывает `webhookSetupHint`
  с URL + verify_token для Meta dashboard copy-paste
- ✅ `WhatsAppClient.getPhoneInfo()` — validate token + phone_number_id +
  return verifiedName + displayPhoneNumber + qualityRating
- 🔲 Diagnostics check для WhatsApp в `/diagnostics` — TODO

### ✅ M3. Embed widget для web — DONE (PR #43)

- ✅ `<script src="<PLATFORM_URL>/widget.js" data-slug="acme"></script>` — auto-init
- ✅ Floating chat bubble (mobile + desktop), настраиваемые цвета через tenant config
- ✅ `apps/widget` — Vite ESM bundle < 50KB gzip, served через `GET /widget.js`
- ✅ `/api/admin/widget/snippet` — генерит готовый HTML snippet для copy-paste
- 🔲 CDN hosting (`cdn.leadengine.app`) — TODO когда появится domain

### ✅ M4. Multi-admin per tenant — DONE (PR #42)

- ✅ `POST /api/admin/admins/invite` — { email, role } → magic link email
- ✅ `POST /api/auth/accept-invite` — token → создать password → join
- ✅ Role-based: `superadmin` (полный доступ), `manager` (read + reply,
  без billing/channels)
- ✅ UI `/team` — list + invite + remove

### ✅ M5. Per-conversation `role='human'` enforcement — DONE (PR #35)

- ✅ `processInbound:347` уже respect'ит `conversation.mode === 'ai'` для запуска
  reply.generate (фиксили инспекцией — pipeline check уже был там)
- ✅ UI badge `[AI | оператор]` + кнопка "Перехватить" / "Вернуть AI"
- ✅ `PUT /api/admin/conversations/:id/mode` — { mode: 'ai'|'human' }, audit-log
  пишет `conversation.mode.takeover` / `.return_to_ai`

---

## Q4 2026 (Sep–Nov) — Vertical templates + agentic actions 🎯

Цель: дифференцироваться через **vertical packs** + начать движение
вверх по autonomy axis (см. [COMPETITORS §3](COMPETITORS.md)).

### M6. Vertical template marketplace (1.0)

5 готовых пакетов с KB seed, funnel stages, prompt fragments:

- [ ] `realestate_leads_v1` — listing inquiries, viewing scheduling, mortgage qualification
- [ ] `clinic_appointments_v1` — **Phase 2 вертикаль #2** (параллельно с RE):
  booking, insurance, pre-visit questionnaires. Telegram-dominant в RU клиниках,
  предсказуемый лид (не сезонный как RE), высокий ARPU.
- [ ] `ecommerce_orders_v1` — order tracking, return policy, shipping
- [ ] `edtech_courses_v1` — course discovery, enrollment, support FAQ
- [ ] `recruitment_v2` — generalize'ить UAE template на любой найм

Каждый vertical: package `@chatman-media/vertical-*`. UI `/settings/vertical`
→ выбор template (live re-apply).

### M7. Agentic actions (tool calls)

Сейчас bot только READS КБ + replies. Чтобы конкурировать с Sierra /
Decagon — agent должен ДЕЛАТЬ. MVP toolset:

- ✅ `booking.get_link()` — `makeBookingLinkTool` wired в RagReplyStrategy (PR #90)
- [ ] `crm.create_lead(name, phone, notes)` — internal leads table или
  outbound HTTP POST к Bitrix24 / AmoCRM
- [ ] `calendar.book_slot(date, slotId)` — native slot-store (сейчас: pass-through ссылка)
- [ ] `payment.create_invoice(amount, currency)` — Stripe / YooKassa
- [ ] `notify.alert_operator(reason)` — escalation в Telegram-чат админов

Tool-loop infra в `@chatman-media/kb` уже есть + wired (PR #90). Расширять
по следующему инструменту: AmoCRM/Bitrix24 create-lead (нужен для Phase 2 CIS).

### M8. Russia/CIS payments + CRM

Stripe не работает в РФ. Нужно для CIS market:

- [ ] YooKassa adapter (`payment-yookassa` package)
- [ ] CloudPayments adapter
- [ ] AmoCRM webhook + REST API integration
- [ ] Bitrix24 webhook + REST API integration

### ✅ M9. Telegram userbot UI onboarding — DONE (май 2026)

Use-case: рекрутеры / sales-teams, чьи лиды пишут на личный аккаунт.

- ✅ `/channels` tab «Telegram (личный аккаунт)» — phone → code → 2FA
- ✅ Пошаговый MTProto-логин (GramJS) через in-memory login-store; session
  string encrypted в `tenant_secrets`
- ✅ Runtime в `apps/api` (не worker — pinned MTProto-соединение, как у web):
  `UserbotChannelRegistry` + inbound-runner (`receive → processInbound`) +
  `UserbotOutboundDispatcher`. `telegram_userbot` убран из claimKinds воркера.
- ✅ Re-auth при revoked-сессии (auth_key_duplicated → status='error' → кнопка в UI)
- ✅ `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` — per-tenant в `tenant_secrets`
  с fallback на env (PR #160); `/userbot/start` просит креды (400) если их нет
- 🔲 QR-code login flow — отложено (текущего phone+code+2FA достаточно)

> **Переоценка (май 2026):** Telegram запустил официальный **Business Account
> Bots API** без требования Premium у пользователя (апр 2026). MTProto userbot
> остаётся для legacy-аккаунтов; новые tenants предпочтительно онбордить через
> официальный Business Bot API (см. M9-bis ниже). Moat — не MTProto-умение,
> а вертикальный контент + persuasion engine + operator UX.

### 🔲 M9-bis. Telegram Business Bot API (Q3 2026)

Официальный API для работы с бизнес-аккаунтами без Premium у пользователя.

- [ ] `channel-telegram` adapter: поддержка `business_connection_id` в webhook
- [ ] `sendMessage` с `business_connection_id` — ответ от имени бизнес-аккаунта
- [ ] UI: новый таб «Telegram (бизнес-аккаунт)» параллельно с userbot
- [ ] Использование Bot-to-bot API для потенциального Managed Bot сценария

---

## Q1 2027 (Dec–Feb) — Scale + Compliance 🛡️

### M10. SOC 2 Type I + GDPR

Готовиться к B2B enterprise sales (см. [COMPETITORS §5](COMPETITORS.md)
moat #5):

- [ ] Audit log retention policy
- [x] Audit log CSV export (`GET /api/admin/audit-log/export.csv`)
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

Двойная стратегия:

- [ ] **OSS edition** под AGPL-3.0 — core packages public; channels +
  enterprise features closed (или dual-license)
- [ ] **Self-host paid** ($24K+/year) — Docker compose + helm chart +
  SSO, advanced RBAC, SLA, dedicated support
- [ ] `apps/installer` — wizard для on-prem setup
- [ ] Vanta-acceptable security boundaries для on-prem audits

### M13. Per-channel pause + dynamic plans

Сейчас `tenant.status='suspended'` рубит все каналы:

- [ ] `channels.status='paused'` per-channel — toggle на каждой строке `/channels`
- [ ] Use-case: outage в OpenAI → pause только AI-replies, operator reply
  через `/conversations` всё ещё работает

### M14. Per-user rate-limit + DB-backed quotas

In-memory rate-limiter уже работает per-tenant. Расширить:

- [ ] Per-user (externalUserId) sliding window — против одного abuser'а
- [ ] DB-backed quota counters для cross-process accuracy (Redis либо
  Postgres atomic UPDATE)
- [ ] Plan-aware limits (free=100/мес кап, pro=unlimited, см. M1)

---

## Q2 2027 (Mar–May) — Agent quality + Marketplace

### M15. Agent QA (auto-grading replies)

Forethought выкатил Agent QA в Sep 2025, рынок будет требовать (см.
[COMPETITORS §7](COMPETITORS.md) trend #5):

**Status (2026-06):** first Quality Lab slice is live. Implemented: `/quality`
UI, self-play checks, pairwise style comparisons, per-style ELO, coach proposals,
shadow evaluations, exchange answer-quality contracts, and tool-call review with
human feedback labels.

Remaining product gaps:

- [ ] Production Agent QA dashboard: % escalation, avg time-to-resolve,
  sentiment drift, top fail-patterns.
- [x] Close the tool-call feedback loop: aggregate wrong/missing/bad-args labels
  and feed them into coach/outcome analysis.
- [ ] Move shadow evaluations from API fire-and-forget into a durable worker/job
  queue with stuck recovery.
- [ ] Add read-only manager access or an explicit product rationale for keeping
  Quality Lab superadmin-only.

### M16. Vertical marketplace 2.0 (paid templates)

- [ ] Open API для агентств / SI-партнёров публиковать vertical packs
- [ ] Revenue share 70/30 (publisher / platform)
- [ ] Examples: "Стоматологическая клиника" (RU/EN), "Salon booking" (FR),
  "Yoga studio" (US)

### M17. Multimodal — image понимание

Vision purpose уже в schema (`llm_provider_configs.purpose='vision'`):

- [ ] processInbound для photo messages — vision model генерит описание
  → pipeline продолжает как text
- [ ] Use-case: клиент шлёт фото товара → bot опознаёт + retrieves KB

### M18. CRM 2.0 — Salesforce + HubSpot

После AmoCRM/Bitrix24 (M8) — выходить на Western рынки:

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
- [ ] **Mobile admin app** (iOS / Android) — операторы отвечают с телефона
- [ ] **Sandbox env per tenant** — testing changes без impact на live
- [ ] **Plugins API** — публичный для custom tool-loop integrations

---

## Что НЕ делаем (отложено осознанно)

Из изначального плана:

- ❌ **Real multi-region / sharding** — один Postgres до ~100 tenant'ов
  одной инстанции хватит
- ❌ **RLS policies для всех CRUDов** — `withTenant` + RLS как defense-in-depth
- ❌ **Custom domains** — subdomain `*.leadengine.app` достаточно до 100+ tenants
- ❌ **Apps/control-plane SPA** — superadmin role flag в admin-ui хватит
- ❌ **Event-sourcing / CQRS** — обычные CRUD + append-only `messages` +
  `audit_log` достаточно
- ❌ **Per-tenant Postgres database** — одна БД, `tenant_id` колонка
- ❌ **Marketplace verticals в БД** — hardcoded import packages до M16

---

## Метрики прогресса

| Метрика | Сейчас (май'26) | Авг'26 | Ноябрь'26 | Дек'26 |
|---|---|---|---|---|
| Signup → first bot reply | < 5 мин self-serve ✅ | < 5 мин | < 3 мин | < 2 мин |
| Active tenants (direct) | 1 (recruitment-uae) | 50 | 200 | 350 |
| Partner deals | 0 | 3 | 8 | 10 |
| MRR | ~$99 | $15K | $70K | **$85K** |
| ARR | ~$1.2K | $180K | $840K | **$1M+** |
| Channel coverage | TG + WA + web + TG userbot | ✅ | + RE vertical | + voice prep |
| Vertical templates | 6 (UAE + generic + RE + SaaS + video + exchange) | 6 | 8 | 10 |
| YouTube videos | 0 | 12 | 30 | 50 |
| Tests | 950+ | 1.2K+ | 1.8K+ | 2.5K+ |
| Compliance | none | none | none | SOC 2 in flight |
| Funding | bootstrap | pitch | raise closed | post-seed |

**Q3 status (июнь–август):** M1–M5 ✅ (billing, channels, widget, team, operator).
Pricing pivot ✅. GTM-инфра ✅ (рефкоды, generic template, dashboard metrics).
**Приоритет:** деплой + демо-бот + первые 50 прямых клиентов + 3 партнёра.

**Q4 status (сент–ноябрь):** M9 ✅ (TG userbot). Admin-UI редизайн ✅.
**Приоритет:** закрыть раунд → найм сейлза → real estate вертикаль → 200 клиентов.

---

## Decision log (открытые вопросы)

1. **Дуальная лицензия (AGPL + commercial)?** — да к Q4 2026 (см. M12).
   Open-source как distribution channel + защита от копи-кэт'ов.
2. **Hosted region для пилотов** — EU (Frankfurt) для GDPR-готовности +
   RU/CIS клиенты через CloudFlare прокси.
3. **Primary persona для маркетинга** — recruitment agencies UAE/CIS
   (текущий tenant), expand к dental clinics RU + edtech SEA. Каждый
   vertical pack (M6) = отдельная посадочная.
4. **Web widget brand** — нужно ли rebrand'ить от Lead Engine? Engineering-
   frontale название, продажникам может не зайти. Re-name к Q4'26 после
   первых 5 paying customers.
5. **Voice partner** — Vapi vs Retell vs Bland.ai. Решение через 6 месяцев.
6. **OSS license** — AGPL-3.0 (forces SaaS rebuild) vs MIT (max adoption).
   Lean к AGPL — main moat это data + multi-tenant + Telegram-native, не код.

---

## Краткий summary

**Где мы сейчас (PR #160, июнь 2026):**

- Self-service onboarding end-to-end без env vars / рестартов
- Channels: TG bot + TG userbot + WhatsApp + Facebook + VK + MAX + web widget — все через UI
- LLM: BYOK provider slots (OpenAI / OpenRouter / Ollama, optional
  purpose-specific Jina/Cohere reranker and transcription), hot-reload
- KB: file/text upload + RAG, dedup по content_hash, **quota enforcement**
- **Stripe billing wired** — 14-day trial, customer portal, 402 quota enforcement
- Operator inbox: auto-poll 5s, mode-toggle takeover, audit log, pause/resume
- **Auth**: forgot-password/reset-password flow с email, change-password, team invite email
- **Superadmin panel**: список всех тенантов, ручная смена плана
- **Outreach broadcasts**: массовая рассылка по leadIds / stageSlug, scheduledAt
- **Message templates**: CRUD шаблонов сообщений
- **GTM-инфра:** партнёрские коды, `recruitment_generic` + `leadengine_sales_v1` + `real_estate` + `saas` + `video` шаблоны, метрика «закрыто ботом», sales-бот KB
- **Agentic tool calls:** booking link wired, tool-loop engine готов к расширению
- **RAG v2:** multi-query expansion (RRF merge) + MMR diversification + dynamic threshold + Jina/Cohere reranker
- **AI Workflow Builder (универсальный):** диалог с AI → воронка за 5 минут; собирает
  линейные **И мульти-запросные** (концерж/сервис-деск) воронки + стиль + навыки +
  пер-стадийное поведение бота + оператор-handoff. Phase 2 behavior-слой завершён
- **Exchange vertical (`exchange_v1`):** крипто/RUB → THB для обменников Пхукета, approved rate-card, exchange orders CRM, exchange e2e mocks
- **QR/photo delivery:** оператор отправляет cardless-withdrawal QR клиенту через admin-UI
- **9 vertical templates:** exchange + concierge + recruitment + modeling +
  real_estate + saas + video + visa + scooter
- **Универсальный костяк воронки (`phase`):** общая ось фаз над всеми
  вертикалями + валидация + phase-stats
- **Закрытая регистрация + gated vertical-aware онбординг:** invite-flow,
  обязательный визард, per-tenant креды каналов (TG MTProto + WhatsApp +
  Facebook + VK + MAX)
- **Admin copilot:** page-aware AI-ассистент на всех страницах (BYOK, advice+confirm)
- **Надёжность обменника:** guardrails курсов + ops-алерты владельцу
- **CI-безопасность:** CodeQL + Dependabot + Codecov
- **950+ tests**, multi-tenant RLS, encrypted secrets, observability
- 1 живой prod tenant (recruitment UAE), Stripe-ready

**Что не сделано и блокирует продажи:** деплой на домен. Одна неделя работы.

**Ближайшие 30 дней (июнь 2026):**
1. Задеплоить на Railway/Render + домен → первая публичная ссылка
2. Запустить демо-бот в Telegram (recruitment_generic шаблон)
3. 500 холодных DM рекрутинговым агентствам в Telegram
4. 4 YouTube-видео (демо живых разрезов, UAE-кейс)
5. 10 питчей инвесторам в Telegram

**$1M ARR путь:** прямые клиенты ($99-199) + партнёры-агрегаторы ($2-5K/сделка)
+ pre-seed раунд → сейлзы. Цель: 3 партнёра к августу, 10 к декабрю.
Один партнёр с 50 клиентами = $7K MRR за одну сделку.

**Q3'26:** деплой → первые клиенты → real-estate вертикаль activate.

**Q4'26:** agentic tool-loop (AmoCRM/Bitrix24), Telegram Business Bot API.

**Q1'27:** SOC 2 Type I, voice (Vapi), self-host AGPL dual edition.

**Moat:** BYOK + Telegram-first + multi-tenant agency + NEPQ/Cialdini engine +
operator handoff + RAG v2 (multi-query + reranker). Ни один конкурент не шипает
всё это вместе. См. [`COMPETITORS.md`](COMPETITORS.md).
