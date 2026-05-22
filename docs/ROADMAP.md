# Roadmap

Последнее обновление: 2026-05.

Стратегический контекст — см. [`COMPETITORS.md`](COMPETITORS.md).

**TL;DR позиционирование:** AI-first customer service для мессенджер-
центричных рынков (Telegram + WhatsApp first, web — поддержка). Мы
играем в middle band ($30–$500/мес SaaS) с moat'ом которого нет у
Chatbase / Tidio Lyro / Crisp: **BYOK + Telegram-native + multi-tenant
agency mode + operator handoff first-class + OSS-ready core**.

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

### SaaS self-service (PR #19–33, 12 PRs в одной сессии)

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

### Reliability infra

- ✅ RLS-enforcement check на boot (warning если pod под BYPASSRLS role)
- ✅ Encrypted secrets (AES-256-GCM) + `getDecryptedSecret` / `setEncryptedSecret`
- ✅ Idempotency keys в `outbound_queue` (SKIP LOCKED, дедуп reply)
- ✅ Signature verification (Telegram secret-token, WhatsApp HMAC, Stripe HMAC)
- ✅ Anti-enumeration в whatsapp-webhook (signature check до tenant lookup)
- ✅ Observability — `PlatformMetrics` + `JsonLogger` + `makeMetricsSink`
- ✅ **700+ tests** (multi-tenant E2E, RLS contract, withTenant wiring, split-pipeline invariant, ratelimit, hot-reload)

---

## Q3 2026 (Jun–Aug) — Monetization + Coverage 💰

Цель: довести продукт до точки **"платящий клиент №1"** + добавить
critical channel coverage.

### M1. Stripe billing wire-up

Схема `stripe_customers` / `stripe_subscriptions` уже есть (миграция
0006). Не хватает:

- [ ] Plan tiers: `free` (100 convo/мес, 1 канал, 50 КБ docs), `starter`
  $49/мес (1K convo, 3 канала, 500 docs), `pro` $149/мес (10K, 10
  каналов, unlimited), `enterprise` self-host (см. COMPETITORS §6)
- [ ] `POST /api/admin/billing/checkout` — создаёт Stripe Checkout Session
- [ ] `POST /webhook/stripe` (route уже есть!) — обрабатывать
  `customer.subscription.created/updated/deleted`, mutate `tenants.plan`
- [ ] Plan enforcement: rate-limiter читает лимит из plan
- [ ] Stripe Customer Portal link в `/settings`
- [ ] Trial: 14 дней `pro` после signup, потом downgrade на `free`

**Bizdev**: первые 3–5 клиентов вручную выставлять счёт. Stripe важен
когда onboard #5+.

### M2. WhatsApp channel UI

Telegram-onboarding уже работает. WhatsApp template-flow:

- [ ] UI `/channels` → tab "WhatsApp" → paste {phone_number_id, access_token}
- [ ] Encrypt token, insert `channels(kind='whatsapp')`
- [ ] Meta webhook setup (нельзя авто — UI генерит copy-paste snippet
  с verify_token + URL для Meta dashboard)
- [ ] Diagnostics check для WhatsApp: `GET /<phone_number_id>/messaging_profile`

### M3. Embed widget для web

Channel-web уже есть (WS-based), но клиент должен своими руками вставлять
JS. Нужен:

- [ ] `<script src="https://cdn.leadengine.app/widget.js" data-slug="acme"></script>`
- [ ] Floating chat bubble (mobile + desktop), customizable colors per tenant
- [ ] `apps/widget` — Vite-built ESM bundle, размер < 50KB gzip
- [ ] `/api/admin/widget/snippet` — генерит готовый snippet

### M4. Multi-admin per tenant

Сейчас только один admin. Команды нужны:

- [ ] `POST /api/admin/admins/invite` — { email, role } → magic link email
- [ ] `POST /api/auth/accept-invite` — token → создать password → join
- [ ] Role-based: `superadmin` (полный доступ), `manager` (read + reply,
  без billing/channels)
- [ ] UI `/team` — list + invite + remove

### M5. Per-conversation `role='human'` enforcement

Сейчас `operator-reply` ставит `mode='human'` но pipeline не читает —
AI снова отвечает на следующий inbound. Fix:

- [ ] processInbound читает `mode='human'` → пропускает reply.generate
- [ ] UI badge "Manual mode" + кнопка "Return to AI" (mode → 'ai')

---

## Q4 2026 (Sep–Nov) — Vertical templates + agentic actions 🎯

Цель: дифференцироваться через **vertical packs** + начать движение
вверх по autonomy axis (см. [COMPETITORS §3](COMPETITORS.md)).

### M6. Vertical template marketplace (1.0)

5 готовых пакетов с KB seed, funnel stages, prompt fragments:

- [ ] `ecommerce_orders_v1` — order tracking, return policy, shipping
- [ ] `realestate_leads_v1` — listing inquiries, viewing scheduling, mortgage qualification
- [ ] `edtech_courses_v1` — course discovery, enrollment, support FAQ
- [ ] `clinic_appointments_v1` — booking, insurance, pre-visit questionnaires
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

### M9. Telegram userbot UI onboarding

Userbot (MTProto) уже работает в `apps/worker`. Нет UI:

- [ ] `/channels` tab "Telegram (личный аккаунт)" — phone, code, 2FA
- [ ] QR-code login flow
- [ ] Session string encrypted в `tenant_secrets`
- [ ] Use-case: рекрутеры / sales-teams чьи лиды пишут на личный аккаунт

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
| Signup → first bot reply | ~10 мин (manual help) | < 5 мин self-serve | < 3 мин | < 2 мин |
| Active tenants | 1 (sales-guru legacy) | 5–10 | 25–50 | 100+ |
| MRR | $0 | $1K | $10K | $50K |
| Channel coverage | TG bot + WA backend + web | + WA UI + widget | + TG userbot UI | + voice |
| Vertical templates | 1 (UAE) | 1 | 5 | 8 |
| Tests | 700+ | 1K+ | 1.5K+ | 2K+ |
| Compliance | none | none | none | SOC 2 Type I in flight |

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

**Где мы сейчас:** инфра-фундамент готов, self-service onboarding работает
(12 PR'ов за май 2026), 1 живой prod tenant (recruitment UAE), 700+ tests,
hot-reload без рестартов, multi-tenant с RLS.

**Куда движемся:** monetization (Stripe), channel coverage (WhatsApp UI,
web widget, voice), vertical packs (e-commerce / real-estate / clinic /
edtech), агентность (tool-loop), enterprise readiness (SOC 2).

**Где наш moat:** BYOK + Telegram-native + multi-tenant agency + operator
handoff first-class + OSS-ready. См. [`COMPETITORS.md`](COMPETITORS.md) §5.
