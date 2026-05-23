# Roadmap

Последнее обновление: 2026-05-23 (переоценка конкурентов + стратегия).

Стратегический контекст — см. [`COMPETITORS.md`](COMPETITORS.md).

**TL;DR позиционирование (Phase 1):** Первый AI рекрутер с **Persuasion Engine**
для Telegram. Отвечает на входящих кандидатов за 30 секунд, ведёт по NEPQ-
методологии, не теряет лидов — передаёт рекрутеру только горячие анкеты.
BYOK, RU/CIS/MENA рынок, flat-fee $99/мес.

> **Позиционирование Phase 2 (месяц 4+):** Расширение на real estate +
> dental/clinic + agency-tier SKU. **Phase 3:** horizontal CX, OSS, voice.

---

## Стратегический план: Phase 1 → 2 → 3

| Фаза | Период | ICP | MRR target | Trigger |
|------|--------|-----|------------|---------|
| **Phase 1** | месяцы 1–3 | Recruitment agencies RU/CIS/MENA | $1–1.5K | launch |
| **Phase 2** | месяцы 4–9 | + Real estate + Dental/Clinic | $5–10K | $1K MRR + 10 customers + case study |
| **Phase 3** | месяцы 10–15 | Horizontal: coaching, B2B SaaS, edtech | $50K+ | $10K MRR + 50 customers |

### Phase 1 metrics (tracking)

| Метрика | Месяц 1 | Месяц 2 | Месяц 3 |
|---|---|---|---|
| Cumulative outreach DMs | 60 | 200 | 350 |
| Demos | 5 | 15 | 30 |
| Paying customers | 1 | 5 | 10–15 |
| MRR | $99 | $500–1K | $1–1.5K |
| Case studies live | 0 | 0–1 | 1–2 |

### Phase 1 приоритетные moat'ы

1. **Recruitment-vertical expertise** — `recruitment_uae_v1` pack в проде
2. **Sales-engine (SPIN + NEPQ + Cialdini)** — `@chatman-media/sales` + 3 Phase 1 skills
3. **Telegram-first** — RU/CIS/MENA доминирующий канал
4. **BYOK** — ARPU-sensitive агентства используют свой OpenAI ключ
5. **Operator handoff** — built-in inbox, не $300/мес add-on

---

---

## Done ✅ (что уже работает в проде)

### Foundation (этапы 1–7 из легаси-плана)

- ✅ Drizzle schema unification (34 tenant-scoped таблицы)
- ✅ Channel-core контракт + channel-telegram / channel-whatsapp / channel-web adapters
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
- ✅ **741 tests** across 13 packages (apps/api: 305; kb: 156; sales: 116;
  conversation-engine: 59; channel-whatsapp: 17; observability: 16; worker: 15;
  storage: 15; channel-telegram: 11; channel-web: 11; llm-router: 9;
  verticals: 6; vertical-recruitment-uae: 5). 0 fail.

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

### UX + Telegram userbot (май 2026)

- ✅ **Guided onboarding wizard** (`/onboarding`) — после signup ведёт по шагам
  канал → API-ключи → база знаний → готово, с прогрессом и возобновлением.
  Чеклист и редирект после регистрации ведут в мастер.
- ✅ **Telegram userbot (личный аккаунт) — M9** — пошаговый MTProto-логин
  phone → code → 2FA (GramJS) с in-memory login-store; сессия encrypted в
  `tenant_secrets`. Userbot живёт в `apps/api` (как web): registry + inbound-runner
  (`receive → processInbound`) + outbound-dispatcher. UI: таб «Telegram (личный)» +
  re-auth при revoked-сессии. `apiId/apiHash` платформенные из env.
- ✅ **Admin-UI редизайн** — Tailwind v4 + shadcn/ui, Linear-эстетика
  (oklch-токены, индиго-акцент), левый сайдбар со всеми разделами,
  светлая/тёмная/системная темы. Все страницы переведены на shadcn.

---

## Q3 2026 (Jun–Aug) — Monetization + Coverage 💰

Цель: довести продукт до точки **"платящий клиент №1"** + добавить
critical channel coverage.

### ✅ M1. Stripe billing wire-up — DONE (PR #37 M1a + PR #38 M1b + PR #41 re-price)

- ✅ Plan tiers: `free` (1 канал, 50 docs, 30/min), `starter` **$99/мес** (3/500/60),
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

- [ ] `calendar.book_slot(date, slotId)` — встроенный slot-store
- [ ] `crm.create_lead(name, phone, notes)` — internal leads table или
  outbound HTTP POST к Bitrix24 / AmoCRM
- [ ] `payment.create_invoice(amount, currency)` — Stripe / YooKassa
- [ ] `notify.alert_operator(reason)` — escalation в Telegram-чат админов

Tool-loop infra в `@chatman-media/kb` уже есть (PR #18). Расширить под
general-purpose.

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
- ✅ Платформенные `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` (env)
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

- [ ] `sales-package` уже имеет CoachAnalyzer + ELO. Generalize'ить под
  "is this reply good?" с LLM-judge
- [ ] UI `/quality` — dashboard: % escalation, avg time-to-resolve,
  sentiment drift, top fail-patterns
- [ ] Per-style ELO ranking — какой prompt-style лучше в этом tenant'е

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

| Метрика | Сейчас | Q3 target | Q4 target | Q1'27 target |
|---|---|---|---|---|
| Signup → first bot reply | < 5 мин self-serve ✅ | < 5 мин | < 3 мин | < 2 мин |
| Active tenants | 1 (recruitment-uae) | 5–10 | 25–50 | 100+ |
| MRR | $0 | $1K | $10K | $50K |
| Channel coverage | TG + WA + web + **TG userbot** (UI) | + widget | ✅ TG userbot UI | + voice |
| Vertical templates | 1 (UAE) | 1 | 5 | 8 |
| Tests | 741 | 1K+ | 1.5K+ | 2K+ |
| Compliance | none | none | none | SOC 2 Type I in flight |
| Monetization | Stripe-ready ✅ | first paying #1 | $10K MRR | $50K MRR |

**Q3 status:** M1 ✅, M2 ✅, M3 ✅, M4 ✅, M5 ✅. Phase 1 pricing pivot ✅.
Recruitment skills seeds + `recruiter-empathetic-v1` style ✅.

**Q4 status:** M9 (Telegram userbot UI + runtime) ✅. Guided onboarding wizard ✅.
Admin-UI редизайн (Tailwind v4 + shadcn, dark/light) ✅. M6–M8 — впереди.

---

## Decision log (открытые вопросы)

1. **Дуальная лицензия (AGPL + commercial)?** — да к Q4 2026 (см. M12).
   Open-source как distribution channel + защита от копи-кэт'ов.
2. **Hosted region для пилотов** — EU (Frankfurt) для GDPR-готовности +
   RU/CIS клиенты через CloudFlare прокси.
3. **Primary persona для маркетинга** — recruitment agencies UAE/CIS
   (текущий tenant), expand к dental clinics RU + edtech SEA. Каждый
   vertical pack (M6) = отдельная посадочная.
4. **Web widget brand** — нужно ли rebrand'ить от lead-engine? Engineering-
   frontale название, продажникам может не зайти. Re-name к Q4'26 после
   первых 5 paying customers.
5. **Voice partner** — Vapi vs Retell vs Bland.ai. Решение через 6 месяцев.
6. **OSS license** — AGPL-3.0 (forces SaaS rebuild) vs MIT (max adoption).
   Lean к AGPL — main moat это data + multi-tenant + Telegram-native, не код.

---

## Краткий summary

**Где мы сейчас (после 17 PR'ов май 2026):**

- Self-service onboarding работает end-to-end без env vars / рестартов
- Channels: **Telegram + WhatsApp** через UI с auto-validate + encrypt + hot-reload
- LLM: BYOK для OpenAI / Anthropic / OpenRouter / Ollama, hot-reload
- KB: file/text upload + RAG retrieval, dedup по content_hash
- **Stripe billing wired** — checkout с 14-day trial, customer portal, webhook
  sync `tenants.plan`. 402 quota enforcement
- Operator: inbox с auto-poll 5s, reply через UI, mode-toggle для takeover,
  audit log всех действий, diagnostics, pause/resume bot
- 741 tests, multi-tenant RLS, encrypted secrets, rate-limit, observability
- 1 живой prod tenant (recruitment UAE), Stripe-ready

**Куда движемся (Phase 1, ближайшие 3 мес):** cold outreach 60→350 DMs,
первые платящие клиенты ($1–1.5K MRR), landing page для recruitment ICP.
Код: только customer-driven (AmoCRM/Bitrix24 если prospect просит).

**Q4'26 (Phase 2 trigger):** real-estate vertical pack, `vertical-realestate-v1`,
agency SKU, Stripe live mode → авто-billing вместо ручного инвойсинга.

**Q4'26 также:** 5 vertical packs (e-commerce / real-estate / clinic / edtech /
recruitment v2), agentic tool-loop (calendar/CRM/payment), AmoCRM/Bitrix24
для CIS, TG userbot UI.

**Q1'27:** SOC 2 Type I, voice channel (Vapi), self-host AGPL dual edition.

**Где наш moat:** BYOK + Telegram-native + multi-tenant agency + operator
handoff first-class + OSS-ready. См. [`COMPETITORS.md`](COMPETITORS.md) §5.
