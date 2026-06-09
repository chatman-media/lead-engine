# Onboarding (tenant journey)

Полный путь от доступа к кабинету до "бот отвечает клиентам".
Self-service через **обязательный onboarding-визард**, без env vars и без
рестартов apps. Визард **vertical-aware**: набор шагов зависит от выбранной
вертикали (generic vs обменник).

---

## Prerequisites

1. Развёрнуты `apps/api` + `apps/worker` + `apps/admin-ui` (см.
   [`../../README.md#quick-start`](../../README.md))
2. `PLATFORM_PUBLIC_URL` задан в env apps/api (например `https://api.acme.com`)
   — нужен чтобы auto-setWebhook работал
3. У бизнеса есть:
   - OpenAI / Anthropic / OpenRouter API key (BYOK)
   - Telegram bot token (через `@BotFather` за 30 секунд) — или личный
     аккаунт для userbot (MTProto), или WhatsApp Cloud API
   - (опц.) document'ы с информацией бизнеса для KB (тарифы, FAQ, политика)

---

## Шаг 1. Доступ и onboarding-визард

### 1a. Регистрация закрыта по умолчанию

Публичный self-service signup **закрыт**: `POST /api/auth/signup` → `403
signup_disabled`, страницы `/signup` в admin-UI больше нет. Открывается
только явно — env `ALLOW_PUBLIC_SIGNUP=1` на apps/api (прокидывается в
`allowSignup`, см. `apps/api/src/index.ts` + `apps/api/src/routes/auth.ts`).

Способы завести tenant'а:

- **Invite** (основной путь) — superadmin шлёт magic-link
  (`POST /api/admin/admins/invite { email, role }`), приглашённый
  активирует через `/accept-invite` (`POST /api/auth/accept-invite
  { token, password }`).
- **Открыть signup** — выставить `ALLOW_PUBLIC_SIGNUP=1` (нужно и для
  локальной разработки, см. [`../../AGENTS.md`](../../AGENTS.md)). Тогда
  `POST /api/auth/signup { email, password, tenantSlug? }` создаёт tenant
  + первого admin'а с `role=superadmin`.

Token живёт 30 дней (`signAuthToken` в `apps/api/src/lib/auth.ts`),
хранится в `localStorage[lead_engine_token]`.

### 1b. Обязательный визард (`/onboarding`)

После логина `OnboardingGate` (`apps/admin-ui/src/App.tsx`) читает
`GET /api/admin/onboarding-status` и редиректит:

- `done=false` → `/onboarding` (кабинет недоступен, пока setup не завершён)
- `done=true` → `/dashboard`

Fail-open: если status-эндпоинт недоступен, считаем `done=true` (не лочим
пользователя).

Визард — **динамическая step-машина** (`apps/admin-ui/src/pages/SaasOnboarding.tsx`),
набор шагов зависит от вертикали:

| Шаг | Generic | Обменник | Обязателен |
|---|:---:|:---:|---|
| Вертикаль (бизнес) | ✓ | ✓ | да |
| Канал | ✓ | ✓ | да (≥1 messenger) |
| LLM | ✓ | ✓ | да (чат-LLM) |
| Курсы | — | ✓ | да (обменник) |
| Реквизиты | — | ✓ | да (обменник) |
| База знаний | ✓ | ✓ | нет |
| Бизнес-данные | — | ✓ | нет |
| Готово | ✓ | ✓ | — |

**Обменник** определяется по `funnels.vertical_template_id='exchange_v1'`
или `funnels.slug='exchange'` (флаг `isExchange` в onboarding-status).

### 1c. Условие завершения (`done`)

`GET /api/admin/onboarding-status` (`apps/api/src/routes/admin-onboarding.ts`)
возвращает: `channelConnected`, `chatLlmConfigured`, `hasKbDocuments`,
`vertical`, `isExchange`, `funnelInstalled`, `activeRateCount`,
`requisiteCount`, `done`.

```
exchangeReady = funnelInstalled && activeRateCount >= 1 && requisiteCount >= 1
done = channelConnected && chatLlmConfigured && (!isExchange || exchangeReady)
```

- **Generic**: достаточно канал + чат-LLM (KB больше **не** входит в `done`).
- **Обменник**: дополнительно нужны установленная воронка + ≥1 активный
  курс + ≥1 реквизит (кошелёк или платёжный метод).

Сайдбар тоже vertical-aware (`apps/admin-ui/src/components/app-shell.tsx`):
обменным тенантам показывается «Обменник» и скрываются «Каталог / Навыки /
Хуки / Стили / Эксперименты / Партнёры»; остальным — наоборот.

---

## Шаг 2. Подключить канал

```
http://localhost:5173/channels
```

UI имеет две вкладки: **Telegram** и **WhatsApp**.

### 2a. Telegram (auto-setWebhook)

1. Открыть Telegram, найти `@BotFather`, отправить `/newbot`
2. BotFather даст token формата `123456789:AAEhBP...`
3. Вставить token в форму "Bot token", нажать "Подключить"

Backend (`POST /api/admin/channels/telegram`):

```
1. Validate format regex /^\d+:[\w-]{30,}$/  → 400 если bad
2. Quota check (canAddChannel) → 402 если over plan limit
3. TelegramClient.getMe() с token             → 401 если bad
4. encrypt token AES-256-GCM → tenant_secrets[channel_telegram_bot_<username>]
5. INSERT channels (kind=telegram_bot, external_id=<username>, ...)
6. setWebhook(url=<PLATFORM_PUBLIC_URL>/webhook/telegram/<tenantSlug>,
              secret_token=<TELEGRAM_WEBHOOK_SECRET>)
7. recordAudit('channel.create', ...)
8. reloader.reloadChannels(tenantId)   ← hot-reload в apps/api
9. apps/worker подхватит ≤30 сек через polling
```

UI отображает:

```
✓ Бот @acme_support_bot подключён и активирован — webhook настроен,
  канал работает.
```

curl-вариант для CI/CD:

```sh
curl -X POST http://localhost:3000/api/admin/channels/telegram \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"botToken":"123456789:AAE..."}'
```

### 2b. WhatsApp (Meta webhook — manual)

1. Открыть [Meta for Developers](https://developers.facebook.com/apps/) →
   ваше WhatsApp Business App → **API Setup**
2. Скопировать `Phone number ID` (15-значный numeric) и сгенерировать
   permanent system user access token (не временный 24h)
3. Вставить оба значения в форму на вкладке "WhatsApp", optional
   `Business Account ID`

Backend (`POST /api/admin/channels/whatsapp`):

```
1. Validate phoneNumberId regex /^\d{10,20}$/ → 400 если bad
2. Quota check → 402 если over limit
3. WhatsAppClient.getPhoneInfo() — GET /<phone_number_id>:
   - 401 если bad token, 404 если bad phoneNumberId
   - returns { verifiedName, displayPhoneNumber, qualityRating }
4. encrypt token → tenant_secrets[channel_whatsapp_<phoneNumberId>]
5. INSERT channels (kind=whatsapp, external_id=phoneNumberId,
                    metadata: { verifiedName, displayPhoneNumber, qualityRating })
6. recordAudit + reloadChannels
```

В отличие от Telegram, **Meta webhook нельзя настроить автоматически** —
Meta не предоставляет API для self-serve webhook subscription. Response
содержит `webhookSetupHint`:

```json
{
  "webhookSetupHint": {
    "url": "https://api.example.com/webhook/whatsapp/acme",
    "verifyToken": "<WHATSAPP_VERIFY_TOKEN>",
    "appSecretHint": "Meta dashboard → App settings → Basic → App Secret — добавить в WHATSAPP_APP_SECRET env"
  }
}
```

UI показывает эти три значения в banner для copy-paste в Meta dashboard
→ Webhooks → Edit subscription:
- **Callback URL** = `webhookSetupHint.url`
- **Verify Token** = `webhookSetupHint.verifyToken`
- Подписаться на `messages` events

После этого Meta отправит GET с challenge, Lead Engine ответит plaintext
challenge (см. `verifyWebhookSubscription` в `packages/channel-whatsapp`).

curl:

```sh
curl -X POST http://localhost:3000/api/admin/channels/whatsapp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumberId":"123456789012345","accessToken":"EAAJZB..."}'
```

### 2bb. Facebook Messenger (Meta webhook — manual)

Канал Messenger ездит на том же Meta Graph API, что и WhatsApp, поэтому
сетап почти идентичен (`packages/channel-facebook` зеркалит
`packages/channel-whatsapp`). Отличия: события вебхука приходят как
`entry[].messaging[]` (а не `entry[].changes[]`), endpoint отправки —
`/me/messages`, а идентификатор канала — это **Facebook Page ID**.

1. Открыть [Meta for Developers](https://developers.facebook.com/apps/) →
   ваше приложение → добавить продукт **Messenger** → раздел
   **Access Tokens**
2. Привязать Facebook Page и сгенерировать **Page Access Token**
   (нужен permission `pages_messaging`; для production — App Review)
3. Вставить Page Access Token в форму на вкладке "Messenger".
   Опционально: per-tenant `Verify Token` и `App Secret`
   (иначе фолбэк на env `FACEBOOK_VERIFY_TOKEN` / `FACEBOOK_APP_SECRET`)

Backend (`POST /api/admin/channels/facebook`):

```
1. pageAccessToken required → 400 если пусто
2. MessengerClient.getPageInfo() — GET /me:
   - 401/403 если bad token
   - returns { id (=pageId), name }
3. validate pageId regex /^\d{5,25}$/ → 400 если bad
4. Quota check → 402 если over limit
5. encrypt token → tenant_secrets[channel_facebook_<pageId>]
   (+ опц. verifyToken / appSecret в tenant_secrets)
6. upsert channels (kind=facebook, external_id=pageId,
                    metadata: { pageName })
7. recordAudit + reloadChannels
```

Как и WhatsApp, **Meta webhook нельзя настроить автоматически**. Response
содержит `webhookSetupHint`:

```json
{
  "webhookSetupHint": {
    "url": "https://api.example.com/webhook/facebook/acme",
    "verifyToken": "<FACEBOOK_VERIFY_TOKEN>",
    "appSecretHint": "Meta dashboard → App settings → Basic → App Secret — добавить в FACEBOOK_APP_SECRET env (или в форме)"
  }
}
```

UI показывает эти значения для copy-paste в Meta dashboard → Messenger →
**Webhooks** → Edit subscription:
- **Callback URL** = `webhookSetupHint.url`
- **Verify Token** = `webhookSetupHint.verifyToken`
- Подписаться на `messages`, `messaging_postbacks` events
- Subscribe приложение к нужной Page

Meta отправит GET с challenge, Lead Engine ответит plaintext challenge
(см. `verifyWebhookSubscription` в `packages/channel-facebook`). Подпись
вебхука (`X-Hub-Signature-256`, App Secret) проверяется на route-слое
**до** tenant lookup (`apps/api/src/lib/facebook-signature.ts`).

> **24-часовое окно.** `send()` использует `messaging_type: "RESPONSE"`.
> Вне 24 часов с последнего сообщения пользователя Meta разрешает только
> сообщения с message tag. Capabilities: `text`, `photo`, `video`,
> `voice`, `document`, `callbackQuery` (postbacks / quick replies),
> `typing`. `edit`/`delete` Send API не поддерживает.

curl:

```sh
curl -X POST http://localhost:3000/api/admin/channels/facebook \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"pageAccessToken":"EAAJZB..."}'
```

### 2bc. VK Messenger (Callback API — manual)

VK-канал работает как бот сообщества: входящие приходят через Callback API,
исходящие отправляются через `messages.send`. MVP поддерживает private
community messages и text-only ответы; личные аккаунты VK, рассылки, клавиатуры
и media-upload не входят в первый срез.

1. Открыть VK community → **Управление** → **Работа с API**
2. Создать/скопировать **ключ доступа сообщества** с правами на сообщения
3. В **Callback API** скопировать **строку, которую должен вернуть сервер**
   (`confirmationCode`) и, опционально, задать **секретный ключ**
4. Вставить `Group ID`, access token, confirmation code и secret key во вкладку
   **VK** на `/channels`

Backend (`POST /api/admin/channels/vk`):

```
1. groupId/accessToken/confirmationCode required → 400 если пусто
2. VkClient.getGroupInfo() — validate group/token через VK API:
   - 401 если bad token / insufficient permissions
   - 404 если groupId не найден
3. Quota check → 402 если over limit
4. encrypt token → tenant_secrets[channel_vk_<groupId>]
   (+ confirmationCode / secretKey в tenant_secrets)
5. upsert channels(kind=vk, external_id=groupId,
                   metadata: { groupName, screenName })
6. recordAudit + reloadChannels
```

Response содержит `webhookSetupHint`:

```json
{
  "webhookSetupHint": {
    "url": "https://api.example.com/webhook/vk/acme",
    "confirmationCode": "<VK_CONFIRMATION_CODE>",
    "secretKeyHint": "Secret key сохранён — payload.secret будет проверяться",
    "eventTypes": ["message_new"]
  }
}
```

В VK Callback API settings:
- **Адрес** = `webhookSetupHint.url`
- Сервер должен вернуть `webhookSetupHint.confirmationCode` на confirmation
- Включить event type `message_new`
- Если задан secret key, VK будет присылать его в `payload.secret`; Lead Engine
  проверит его до pipeline

curl:

```sh
curl -X POST http://localhost:3000/api/admin/channels/vk \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"groupId":"123456789","accessToken":"vk1.a...","confirmationCode":"abcd","secretKey":"optional"}'
```

### 2bd. MAX Messenger (Bot API Webhook — manual)

MAX-канал работает как чат-бот организации/ИП: входящие приходят через Bot API
Webhook, исходящие отправляются через `POST /messages`. MVP поддерживает
text-only `message_created`; media, rich keyboards и callback buttons — follow-up.

Требования MAX API:
- бот создаётся в [business.max.ru](https://business.max.ru/) у верифицированного
  профиля организации/ИП;
- token передаётся только через header `Authorization: <token>`;
- production webhook должен быть HTTPS на порту 443;
- secret из subscription приходит в `X-Max-Bot-Api-Secret`.

1. В business.max.ru открыть **Чат-боты** → **Интеграция**
2. Скопировать **Bot token**
3. Во вкладке **MAX** на `/channels` вставить token; webhook secret можно
   указать вручную или оставить пустым — backend сгенерирует его
4. В MAX создать Webhook subscription на URL из `webhookSetupHint`

Backend (`POST /api/admin/channels/max`):

```
1. botToken required → 400 если пусто
2. MaxClient.getBotInfo() — validate bot token через GET /me:
   - 401 если bad token / insufficient permissions
3. Quota check → 402 если over limit
4. encrypt token → tenant_secrets[channel_max_<botId>]
5. encrypt webhook secret → tenant_secrets[channel_max_<botId>_webhook_secret]
6. upsert channels(kind=max, external_id=botId,
                   metadata: { username, botName })
7. recordAudit + reloadChannels
```

Response содержит `webhookSetupHint`:

```json
{
  "webhookSetupHint": {
    "url": "https://api.example.com/webhook/max/acme/778899",
    "secret": "max_...",
    "updateTypes": ["message_created"],
    "requirement": "Production MAX webhooks require HTTPS on port 443."
  }
}
```

MAX Webhook subscription:
- **URL** = `webhookSetupHint.url`
  (`/webhook/max/<tenantSlug>/<botId>` — `botId` нужен для tenants с несколькими MAX-ботами)
- **Secret** = `webhookSetupHint.secret`
- **Update types** = `message_created`
- Lead Engine проверяет `X-Max-Bot-Api-Secret` до pipeline

curl:

```sh
curl -X POST http://localhost:3000/api/admin/channels/max \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"botToken":"max-bot-token","webhookSecret":"optional"}'
```

### 2c. Telegram userbot (личный аккаунт, MTProto)

Помимо бота, тенант может подключить **личный аккаунт** (userbot) для
работы из обычного Telegram-аккаунта. Подсистема userbot **always-on**;
MTProto-креды (`api_id` / `api_hash` с my.telegram.org) хранятся
**per-tenant** в `tenant_secrets` с fallback на env `TELEGRAM_API_ID` /
`TELEGRAM_API_HASH` (`apps/api/src/lib/userbot-creds.ts`).

Flow (вкладка "Личный аккаунт"):

```
POST /api/admin/channels/userbot/start  { phone, apiId?, apiHash? }
  ├─ apiId/apiHash переданы → валидируются и сохраняются в tenant_secrets
  ├─ не переданы → резолв из tenant_secrets, затем env
  ├─ кредов нет нигде → 400 "укажите API ID и API Hash" (а не глобальный 503)
  └─ ок → MTProto sendCode → { loginId, awaiting: "code" }
POST /api/admin/channels/userbot/verify { loginId, code }   → signIn / needs2fa
POST /api/admin/channels/userbot/2fa    { loginId, password } → SRP → канал создан
```

### 2d. Per-tenant креды каналов

WhatsApp `verify_token` / `app_secret` тоже **per-tenant** (`tenant_secrets`,
ключи в `requisite-keys`/channel-секретах) с fallback на env
`WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET`. Передаются в
`POST /api/admin/channels/whatsapp { verifyToken?, appSecret? }` и сохраняются,
если указаны. То есть один деплой обслуживает разных тенантов с их
собственными Meta-приложениями без общих env.

---

## Шаг 3. Настроить LLM

```
http://localhost:5173/settings
```

LLM-шаг визарда — компактный **accordion по всем purpose'ам**: `chat`
(раскрыт + обязателен) и сворачиваемые опциональные `embed` / `vision` /
`judge` / `reranker`. Списки провайдеров и плейсхолдер модели адаптируются
под purpose (например, reranker → jina/cohere; OpenRouter → подсказка
`google/gemini-2.5-flash`). Каждый purpose сохраняется через
`PUT /api/admin/llm-configs/:purpose`.

### Chat config

- Provider: `openai` / `openrouter` / `anthropic` / `ollama`
- Model: например `gpt-4o-mini`
- API key: вставляется один раз, encrypted AES-256-GCM
- Base URL: опционально (для прокси / Ollama локального)
- Timeout: опционально

### Embed config (нужен для RAG)

- Provider: обычно `openai`
- Model: `text-embedding-3-small`
- API key (нужно paste отдельно — даже если совпадает с chat-ключом)
- **Embed dim**: дефолт **1536** (фиксированный размер колонки `kb_chunks`).
  Любая современная модель авто-подгоняется под целевую размерность через
  `fitDim()` в `llm-router` (truncate + L2-renormalize — валидная Matryoshka-
  редукция для OpenAI v3 / Gemini embedding и т.д.), так что выбирать dim
  вручную больше не нужно.

Backend (`PUT /api/admin/llm-configs/chat`):

```
1. Validate provider ∈ {openai, openrouter, ollama, anthropic}
2. Validate non-ollama → apiKey required (или secret_ref уже есть)
3. embed purpose → embedDim required
4. encrypt apiKey → tenant_secrets[llm_chat_apikey]
5. UPSERT llm_provider_configs (tenantId, purpose, ...)
6. recordAudit('llm_config.create' | 'update', ...)
7. reloader.reloadLlm(tenantId):
   - InMemoryLlmRouter.invalidate(tenantId)
   - setConfig для каждого purpose
   - mutate LoadedRef.current
```

curl:

```sh
curl -X PUT http://localhost:3000/api/admin/llm-configs/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-..."}'

curl -X PUT http://localhost:3000/api/admin/llm-configs/embed \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider":"openai","model":"text-embedding-3-small","apiKey":"sk-...","embedDim":1536}'
```

---

## Шаг 4. Настроить воронку

```
http://localhost:5173/funnel
```

### A. Загрузить готовый шаблон

Нажать "Загрузить шаблон" → выбрать нужный:

| Шаблон | Описание |
|--------|---------|
| `recruitment` | Найм (UAE/виза) — расширенная воронка с docs/visa-стадиями |
| `recruitment_generic` | Найм — простая воронка: лид → квалификация → оффер |
| `real_estate` | Недвижимость — просмотры → оффер → NOC/ипотека → передача |
| `saas` | SaaS — discovery → demo → proposal → подписка |
| `video` | Видеопродакшн — бриф → смета → съёмка → монтаж → сдача |
| `exchange` | Обменник — крипта/RUB → THB наличные (11 стадий) |

> Это ключи `POST /api/admin/funnel/seed` (`SEED_TEMPLATES` в
> `apps/api/src/routes/admin-funnel.ts`). Дополнительно есть ключи `visa`,
> `modeling`, `leadengine_sales_v1` (мета-демо продажи самого Lead Engine) и
> `skeleton` (пустой универсальный костяк для новой вертикали). В визарде шаг
> «Вертикаль» устанавливает соответствующий **vertical template** (`exchange_v1`,
> `real_estate_v1`, `recruitment_v1`, `saas_v1`, `video_v1`) — он сеет
> воронку **и** проставляет `funnels.vertical_template_id`.

```sh
curl -X POST http://localhost:3000/api/admin/funnel/seed \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"template":"recruitment_generic"}'
```

### B. Настроить с AI (рекомендовано)

Нажать "Настроить с AI" → откроется чат-панель. Описать бизнес в свободной
форме — AI задаёт уточняющие вопросы и генерирует воронку под конкретный бизнес.
Когда AI готов — показывает preview стадий и полей. Нажать "Применить воронку"
→ стадии устанавливаются мгновенно.

### C. Создать вручную (drag-drop)

Добавить стадии и поля через drag-drop редактор на `/funnel`. Типы стадий
(`STAGE_TYPES`): `form_fill`, `document_upload`, `document_signature`,
`rate_confirmation`, `external_approval`, `payment`, `awaiting_operator`,
`interaction`, `assessment`, `waiting`, `milestone`. Типы полей
(`FIELD_TYPES`): `text`, `textarea`, `number`, `date`, `select`,
`multiselect`, `boolean`, `phone`, `email`, `photo`, `file`, `video`.

### D. Костяк воронки (универсальный `phase`)

Поверх произвольных стадий лежит **универсальная ось фаз** — общий язык для
всех вертикалей (`packages/verticals/src/phases.ts`, миграция
`0031_stage_phase.sql`):

```
capture → qualify → offer → [clear] → [fulfill] → won / lost
```

- В БД у активных стадий хранится `stage_definitions.phase` ∈
  `qualify | offer | clear | fulfill`; якоря `capture/won/lost` выводятся
  из `kind` (intake / terminal_won / terminal_lost).
- `qualify` и `offer` обязательны в каждой воронке; `clear` (KYC/комплаенс/
  документы) и `fulfill` (доставка/оплата) опциональны.
- AI-builder и `POST /api/admin/workflows/apply` валидируют костяк
  (`validateBackbone`): монотонность фаз, наличие intake/terminal,
  обязательные `qualify`/`offer` — иначе `400` со списком нарушений.
- `GET /api/admin/funnel/phase-stats` даёт vertical-agnostic метрику —
  число лидов в каждой фазе (сравнимо между вертикалями).

Подробнее — [`ARCHITECTURE.md#funnel-phase-backbone`](ARCHITECTURE.md) и
[`VERTICALS.md`](../strategy/VERTICALS.md).

---

## Шаг 4b. (Обменник) Курсы и реквизиты

> Полное описание системы обмена (курсы, guardrails, ops-watch, реквизиты,
> orders) — [EXCHANGE.md](EXCHANGE.md).

Для обменных тенантов визард добавляет обязательные шаги **Курсы** и
**Реквизиты** (и опциональные **Бизнес-данные**).

### Курсы (`/exchange` → Rate card)

- Базовые курсы (`exchange_rates`): asset+network, маржа %, фикс-комиссия
  (THB), мин/макс, авто-обновление с рыночного фида.
- Approved rate tiers (`exchange_rate_tiers`): объёмные ступени с
  `display_rate` (показывается клиенту) и `market_rate` (референс).
- Эндпоинты: `GET/POST /api/admin/exchange/rates`,
  `POST /api/admin/exchange/rates/refresh`,
  `POST /api/admin/exchange/rate-card/preview|approve`.
- Курсы проходят **guardrails** (`apps/api/src/lib/exchange/guardrails.ts`):
  отклонение эффективного курса от базового > `maxDeviationPct` (дефолт 35%)
  → отказ от котировки (ловит опечатки тарифа и мусор из фида).

### Реквизиты (`/exchange` → Requisites)

Шифрованные `tenant_secrets` (allowlist в
`apps/api/src/lib/exchange/requisite-keys.ts`):

- кошельки по asset/network (`exchange_wallet_*`);
- фиксированные платёжные ключи (фиат payment URL, Binance ID, реквизиты карты);
- бизнес-данные (контакт оператора, методы выплат, KYC-политика, часы, адрес).

Эндпоинты `GET/POST /api/admin/exchange/requisites`. Для завершения
onboarding обменника нужен ≥1 активный курс **и** ≥1 реквизит.

---

## Шаг 5. Загрузить документы

```
http://localhost:5173/dashboard
```

Два пути:

### A. Upload файл

`.txt` / `.md` / `.json` файлы (PDF — TBD). Multipart POST.

```sh
curl -X POST http://localhost:3000/api/admin/kb/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@faq.md' \
  -F 'title=Часто задаваемые вопросы' \
  -F 'topic=faq'
```

### B. Paste text

JSON body `{ title, body, topic? }`:

```sh
curl -X POST http://localhost:3000/api/admin/kb/documents \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Условия возврата",
    "topic": "policy",
    "body": "Возврат в течение 14 дней. Полная сумма если товар не использовался..."
  }'
```

Backend:

```
1. ingestText(body) → split на chunks (chunked по tokens) →
   embed каждый chunk через resolveEmbedder(tenantId) → INSERT kb_chunks
2. content_hash dedup → если same body → return existing, created=false
3. created=true когда новый row
```

---

## Шаг 6. Проверить что работает

### A. Статус onboarding

Прогресс отслеживает `GET /api/admin/onboarding-status` (см. [Шаг 1c](#1c-условие-завершения-done)).

```
✓ Вертикаль выбрана
✓ Канал активен                 @acme_support_bot
✓ Чат-LLM настроен              openai / gpt-4o-mini
  (обменник) ✓ Воронка + ≥1 курс + ≥1 реквизит
```

`done=true` (generic) когда канал активен **и** чат-LLM настроен; для
обменника — плюс воронка + ≥1 активный курс + ≥1 реквизит. KB в `done`
**не** входит. Пока `done=false`, `OnboardingGate` держит пользователя
на `/onboarding`; после — пускает в `/dashboard`.

### B. Диагностика

```
http://localhost:5173/diagnostics
```

Нажать "Запустить проверку" — backend прогоняет:

- **channel.telegram** — `getMe` валиден, токен расшифровывается → OK
- **llm.chat** — config есть, apiKey decryptable → OK
- **llm.embed** — config + dim → OK (warn если нет)
- **tenant_secrets** — sanity check

Per check status + latency + сообщение об ошибке.

### C. Отправить тестовое сообщение в бот

В Telegram открыть `@acme_support_bot` → отправить "Какие условия
возврата?".

Bot отвечает (через ~3-5 сек: LLM + RAG retrieval + LLM generate +
worker outbound).

### D. Inbox (`/conversations`)

Диалог появляется в списке. Click → видны user message + assistant
reply.

### E. Перехватить как operator

В thread'е textarea + "Отправить" — после send:

- `messages` INSERT с `role='human'`, `meta_json.adminId=<you>`
- `conversations.mode = 'human'` — AI замолкает на этом conversation
- Outbound queue → worker → клиент получает в Telegram message от
  оператора

Кроме reply есть отдельный toggle "Перехватить" / "Вернуть AI" в header
thread'а — переключает `conversations.mode` без отправки сообщения:

```sh
curl -X PUT http://localhost:3000/api/admin/conversations/<id>/mode \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"human"}'   # AI замолкает
# или
  -d '{"mode":"ai"}'      # AI снова отвечает
```

Use-case: оператор взял диалог, разрулил вручную, нажал "Вернуть AI" —
бот продолжает обработку с того места.

---

## Шаг 7. Операционные действия

### Pause / resume бота

`/dashboard` → "Поставить на паузу" → `tenant.status = 'suspended'` →
`ChannelRegistry.reloadTenant` evict'ит → webhook возвращает 404 →
inbound сообщения отбрасываются (Telegram retry'ит позже).

"Возобновить" → `status='active'` → каналы восстанавливаются.

### Audit log

`/audit` показывает последние 50 действий. Cursor pagination "Загрузить
ещё". Action labels: "Подключён канал", "Изменён LLM конфиг", "Ответ
оператора", "Бот на паузе", etc. Raw secrets никогда не отображаются.

### Rotate token

Просто paste новый token в `/channels` для того же бота → backend
re-encrypts + updates row + reload. Старый ciphertext остаётся в
`tenant_secrets` (manual cleanup отдельной операцией для безопасности).

### Upgrade plan (Stripe Checkout)

Дашборд показывает `PlanWidget` — текущий план, usage bars (каналы /
KB docs / rate), кнопки "Starter $99" / "Pro $199" если на `free`.

Flow:

1. Клик "Starter $99" → `POST /api/admin/billing/checkout { plan: 'starter' }`
2. Backend: `createCustomer` (если нет) + `createCheckoutSession`
   (14-day trial) → возвращает `url`
3. UI: `window.location.href = url` — Stripe Checkout
4. Tenant вводит карту, подтверждает trial
5. Stripe POST `/webhook/stripe` с `customer.subscription.created`:
   - upsert `stripe_subscriptions`
   - priceMap[priceId] → newPlan='starter'
   - `tenants.plan = 'starter'` (status='trialing')
6. Redirect назад на `STRIPE_CHECKOUT_SUCCESS_URL`
7. PlanWidget reload → видит новый план, quota = 3 channel / 500 docs
8. Следующий `POST /api/admin/channels/...` → quota check проходит

Управление подпиской — кнопка "Управлять" в PlanWidget:

1. `POST /api/admin/billing/portal` → returns Stripe Customer Portal URL
2. Tenant меняет карту / cancel / change plan через Stripe UI
3. Webhook events sync обратно `tenants.plan`

curl:

```sh
# Start checkout
curl -X POST http://localhost:3000/api/admin/billing/checkout \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"plan":"starter"}'
# Returns: { ok: true, url: "https://checkout.stripe.com/...", sessionId }

# Customer Portal
curl -X POST http://localhost:3000/api/admin/billing/portal \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}'
# Returns: { ok: true, url: "https://billing.stripe.com/..." }
```

Quota errors (402 Payment Required):

```json
{
  "error": "quota_exceeded",
  "reason": "max_channels",
  "limit": 1, "current": 1,
  "plan": "free", "planLabel": "Free",
  "upgradeHint": "Перейдите на план Starter ($99/мес) для большего числа каналов"
}
```

UI ловит этот response и показывает Upgrade CTA.

### Rotate LLM key

То же самое в `/settings` — paste новый key, save. Hot-reload.

### Отправить QR / фото клиенту из admin-UI

На странице лида (`/leads/:id`) — блок "Отправить QR / фото клиенту".
Вставить Telegram `file_id` или публичный HTTPS URL изображения, нажать "Отправить".
Бот мгновенно пересылает картинку клиенту в Telegram (без перехвата чата).

Основной кейс: оператор обменника сгенерировал cardless-withdrawal QR в банковском
приложении → сохранил как фото → отправляет клиенту через admin-UI.

```sh
curl -X POST http://localhost:3000/api/admin/leads/42/send-photo \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"photoRef":"https://example.com/qr.png","caption":"Ваш QR для ATM"}'
```

---

## Что не нужно делать

- ❌ Менять env vars apps/api / apps/worker. После initial deploy с
  `PLATFORM_MASTER_KEY` / `PLATFORM_PUBLIC_URL` ничего из env tenant
  не трогает.
- ❌ Рестартовать apps. Все изменения hot-reload.
- ❌ Заходить в БД. Все CRUD-операции через UI / admin API.
- ❌ Вручную дёргать `setWebhook` Telegram'у. Авто-настройка при
  channel-create.
- ❌ Делать backup secrets отдельно. `pg_dump` базы достаточно (мастер-
  ключ в env apps/api — храните его отдельно в secret-manager).

---

## Curl playbook (CI / scripting)

Полный onboarding скриптом. **Требует `ALLOW_PUBLIC_SIGNUP=1` на apps/api**
(иначе `POST /api/auth/signup` → `403 signup_disabled`) — либо замените
шаг 1 на invite-flow (`/accept-invite`).

```bash
#!/usr/bin/env bash
set -euo pipefail
API="${API:-http://localhost:3000}"

# 1. Signup (нужен ALLOW_PUBLIC_SIGNUP=1)
SIGNUP=$(curl -fsS -X POST "$API/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$2\",\"tenantSlug\":\"$3\"}")
TOKEN=$(echo "$SIGNUP" | jq -r .token)

# 2. Connect channel
curl -fsS -X POST "$API/api/admin/channels/telegram" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"botToken\":\"$4\"}"

# 3. Configure LLM
curl -fsS -X PUT "$API/api/admin/llm-configs/chat" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"apiKey\":\"$5\"}"

curl -fsS -X PUT "$API/api/admin/llm-configs/embed" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"provider\":\"openai\",\"model\":\"text-embedding-3-small\",\"apiKey\":\"$5\",\"embedDim\":1536}"

# 4. Upload KB
curl -fsS -X POST "$API/api/admin/kb/documents" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"title\":\"FAQ\",\"body\":\"$6\"}"

# 5. Diagnostics
curl -fsS "$API/api/admin/diagnostics" -H "Authorization: Bearer $TOKEN" | jq .
```

Usage:

```sh
./onboard.sh founder@acme.com pwd-12345 acme \
  '12345:AAE...' 'sk-...' 'Возврат в течение 14 дней.'
```

---

## Troubleshooting

| Симптом | Причина | Fix |
|---|---|---|
| Signup → 403 `signup_disabled` | Публичная регистрация закрыта (дефолт) | `ALLOW_PUBLIC_SIGNUP=1` на apps/api, или заводите tenant через invite |
| Signup → 409 conflict | Email или slug уже занят | Сменить email/slug |
| После логина всегда редирект на `/onboarding` | `onboarding-status.done=false` | Доведите обязательные шаги визарда (канал + чат-LLM; обменник: + курс + реквизит) |
| `userbot/start` → 400 «укажите API ID и API Hash» | Нет MTProto-кредов | Передайте `apiId`/`apiHash` в запросе или задайте env `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` |
| Channel POST → 401 | Telegram отверг token | Проверить что скопировали без пробелов |
| Channel POST → 502 | Telegram unreachable | network issue, retry |
| Webhook не приходит | `PLATFORM_PUBLIC_URL` неверный или setWebhook не отработал | Проверить `webhookSet: true` в response; вручную дёрнуть `setWebhook` через `getWebhookInfo` |
| LLM PUT → 500 "requires apiKey" | non-Ollama provider без key | Paste key |
| Bot не отвечает | `tenant.status='suspended'` или LLM key неверный | `/diagnostics` → видно где fail |
| Inbox пустой после сообщения | Webhook не доходит / rate-limit / canal paused | Логи apps/api: `webhookRequests{status="429"}` — over rate limit; `404` — нет канала |
| Send-from-admin → 409 "no channel" | Channel удалён после inbound | Re-paste token в /channels |
| WhatsApp POST → 401 "Meta rejected" | Bad access token (истёк / нет permissions) | Сгенерировать permanent system user token в Meta dashboard |
| WhatsApp POST → 404 "phoneNumberId not found" | Опечатка в phoneNumberId или token не от этой WABA | Скопировать `Phone number ID` точно из API Setup |
| WhatsApp webhook не приходит | Meta dashboard webhook не настроен | Скопировать `webhookSetupHint.url` + `verifyToken` в Meta dashboard → Webhooks |
| VK POST → 401 "VK rejected" | Bad community token или нет прав на сообщения | Создать новый community access token в VK → Работа с API |
| VK webhook не проходит confirmation | Неверный Group ID или confirmation code не сохранён | Скопировать `webhookSetupHint.url` + `confirmationCode` в VK Callback API |
| VK callback → 401 "invalid secret" | Secret key в VK settings не совпадает с сохранённым | Обновить VK secret key на вкладке `/channels` или в VK settings |
| POST /channels → 402 "quota_exceeded" | План free лимит 1 канал | Upgrade на Starter / Pro через PlanWidget или DELETE старого канала |
| POST /kb/documents → 402 | Free план — 50 docs cap | Удалить старые docs или upgrade plan |
| Stripe Checkout → 503 "stripe_not_configured" | `STRIPE_SECRET_KEY` пустой на платформе | Set env STRIPE_SECRET_KEY + STRIPE_PRICE_STARTER + STRIPE_PRICE_PRO |
| После checkout план не обновился | Webhook не получен (нет STRIPE_WEBHOOK_SECRET или Stripe URL не указывает на /webhook/stripe) | Проверить Stripe dashboard → Webhooks → delivery attempts |

---

См. также [`ARCHITECTURE.md`](ARCHITECTURE.md) для глубже под капот.
