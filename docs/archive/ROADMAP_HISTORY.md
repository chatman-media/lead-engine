# Roadmap history — летопись сделанного (до июня 2026)

_Вынесено из [`../strategy/ROADMAP.md`](../strategy/ROADMAP.md) 2026-06-10, чтобы
roadmap оставался планом, а не changelog'ом. Здесь — детальная PR-история «Done»
и история позиционирования. Актуальный срез возможностей — корневой
[`README.md`](../../README.md) и секция «Где мы сейчас» в roadmap._

---

## История позиционирования

1. **Recruitment-first (Phase 1, май 2026).** «Первый AI рекрутер с Persuasion
   Engine для Telegram»: отвечает кандидатам за 30 секунд, ведёт по NEPQ, передаёт
   рекрутеру только горячие анкеты. BYOK, RU/CIS/MENA, flat-fee $99/мес.
   Recruitment остаётся GTM-wedge'ем и в текущем позиционировании.
2. **Exchange-моновертикаль (начало июня 2026).** Live-продукт развёрнут в
   моно-вертикаль **exchanges·agency** (обменники Пхукета); recruitment — PoC-шаблон.
   По объёму разработки exchange стал самой проработанной вертикалью
   (rate-card + guardrails, ops-алерты, KYC/реквизиты, QR-выдача).
3. **Универсальная платформа (2026-06-10, текущий канон).** Любая вертикаль и
   любой набор вертикалей: AI собирает воронку по описанию бизнеса
   ([`../engineering/AI_FUNNEL_BUILDER.md`](../engineering/AI_FUNNEL_BUILDER.md)),
   шаблоны — категории входа. Конвергенция концержа (R1–R5) доказала, что
   AI-билдер строит не только линейные deal-пайплайны, но и мульти-запросные
   сервис-деск воронки — разбор в
   [`../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md`](../engineering/CONCIERGE_FUNNEL_CONVERGENCE.md).

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
  vertical-real-estate/saas/video: 3+3+3). 0 fail. _(Исторический снэпшот;
  к июню 2026 — 2400+.)_

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
- ✅ **«Закрыто ботом» метрика** — карточка на дашборде: сумма лидов в
  `terminal_won` стадиях. Ключевой ROI-показатель для удержания клиентов и YouTube-кейсов
- ✅ **Sales-бот (meta-демо)** — `leadengine_sales_v1` NEPQ-воронка для продажи
  Lead Engine рекрутёрам через Telegram. Полный KB-комплект: обзор продукта,
  кейс UAE, возражения/FAQ, сравнение конкурентов. System prompt «Алекс» с
  Cialdini-элементами. `docs/gtm/sales-bot/` — готово к деплою за 15 минут.
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
- ✅ Integration-тесты: auth forgot/reset, superadmin role guards, message-templates CRUD,
  outreach enqueued/skipped/stageSlug/scheduledAt — против реального PG

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
  → `verification_check` → `kyc_collection` → `risk_review` → `order_created`
  → `requisites_sent` → `payment_proof_waiting` → `payment_verified`
  → `payout_or_completion`. Поля: asset/network/amount/payout_method, курс и THB,
  verification CRM id, risk decision, order id, реквизиты/TTL, чек или tx hash,
  source bank, final payout code/artifact. Двуязычный system prompt (RU/EN).
  Пакет `apps/vertical-exchange`, зарегистрирован в `KNOWN_TEMPLATES` и `SEED_TEMPLATES["exchange"]`.
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
  _(Переработан в июне 2026 в обязательный gated vertical-aware визард.)_
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
  всех вертикалей. `stage_definitions.phase` (миграция `0031_stage_phase.sql`),
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

## Завершённые майлстоуны Q3 2026 (детали)

### ✅ M1. Stripe billing wire-up — DONE (PR #37 M1a + PR #38 M1b + PR #41 re-price)

- ✅ Plan tiers: `free` (self-host/exchange-focused режим с generous limits:
  100 channels / 100K docs / 120 min), `starter` **$99/мес** (3/500/60),
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
- Хвосты (остались в roadmap): plan-aware rate-limiter (M14), email-уведомления
  trial-ending / payment-failed

### ✅ M2. WhatsApp channel UI — DONE (PR #36)

- ✅ UI `/channels` → tab "WhatsApp" → form {phoneNumberId, accessToken, businessAccountId?}
- ✅ Encrypt token (AES-256-GCM), insert `channels(kind='whatsapp')`
- ✅ Meta webhook setup: UI после create показывает `webhookSetupHint`
  с URL + verify_token для Meta dashboard copy-paste
- ✅ `WhatsAppClient.getPhoneInfo()` — validate token + phone_number_id +
  return verifiedName + displayPhoneNumber + qualityRating
- Хвост (остался в roadmap): Diagnostics check для WhatsApp в `/diagnostics`

### ✅ M3. Embed widget для web — DONE (PR #43)

- ✅ `<script src="<PLATFORM_URL>/widget.js" data-slug="acme"></script>` — auto-init
- ✅ Floating chat bubble (mobile + desktop), настраиваемые цвета через tenant config
- ✅ `apps/widget` — Vite ESM bundle < 50KB gzip, served через `GET /widget.js`
- ✅ `/api/admin/widget/snippet` — генерит готовый HTML snippet для copy-paste
- Хвост (остался в roadmap): CDN hosting (`cdn.leadengine.app`) — когда появится domain

### ✅ M4. Multi-admin per tenant — DONE (PR #42)

- ✅ `POST /api/admin/admins/invite` — { email, role } → magic link email
- ✅ `POST /api/auth/accept-invite` — token → создать password → join
- ✅ Role-based: `superadmin` (полный доступ), `manager` (read + reply, без billing/channels)
- ✅ UI `/team` — list + invite + remove

### ✅ M5. Per-conversation `role='human'` enforcement — DONE (PR #35)

- ✅ `processInbound` respect'ит `conversation.mode === 'ai'` для запуска reply.generate
- ✅ UI badge `[AI | оператор]` + кнопка "Перехватить" / "Вернуть AI"
- ✅ `PUT /api/admin/conversations/:id/mode` — { mode: 'ai'|'human' }, audit-log
  пишет `conversation.mode.takeover` / `.return_to_ai`

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
> официальный Business Bot API (M9-bis в roadmap). Moat — не MTProto-умение,
> а вертикальный контент + persuasion engine + operator UX.
