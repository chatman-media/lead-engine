# Onboarding (tenant journey)

Полный путь от "регистрации" до "бот отвечает клиентам в Telegram".
Self-service через UI, без env vars, без рестартов apps.

---

## Prerequisites

1. Развёрнуты `apps/api` + `apps/worker` + `apps/admin-ui` (см.
   [`../README.md#quick-start`](../README.md))
2. `PLATFORM_PUBLIC_URL` задан в env apps/api (например `https://api.acme.com`)
   — нужен чтобы auto-setWebhook работал
3. У бизнеса есть:
   - OpenAI / Anthropic / OpenRouter API key (BYOK)
   - Telegram bot token (создаётся через `@BotFather` за 30 секунд)
   - 1+ document с информацией бизнеса (тарифы, FAQ, политика возврата, и т.д.)

---

## Шаг 1. Signup

```
http://localhost:5173/signup
```

Form:

- **Email** — будет admin login
- **Password** ≥ 8 символов
- **Slug** (опционально) — `acme-corp` → доступ через `acme-corp.leadengine.app`
  в проде. Если пусто — генерится из email (`alice-acme-com` для `alice@acme.com`).

POST → `/api/auth/signup`:

```sh
curl -X POST http://localhost:3000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"founder@acme.com","password":"strong-pwd-12345","tenantSlug":"acme"}'
```

Response:

```json
{
  "token": "eyJhZG...",
  "admin": { "id": 1, "email": "founder@acme.com", "role": "superadmin", "tenantId": 5 },
  "tenant": { "id": 5, "slug": "acme", "plan": "free" }
}
```

Token живёт 30 дней (`signAuthToken` в `apps/api/src/lib/auth.ts`).
Хранится в `localStorage[lead_engine_token]`.

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

---

## Шаг 3. Настроить LLM

```
http://localhost:5173/settings
```

Две секции: **Chat (ответ ассистента)** + **Embeddings (поиск по KB)**.

### Chat config

- Provider: `openai` / `openrouter` / `anthropic` / `ollama`
- Model: например `gpt-4o-mini`
- API key: вставляется один раз, encrypted AES-256-GCM
- Base URL: опционально (для прокси / Ollama локального)
- Timeout: опционально

### Embed config (нужен для RAG)

- Provider: обычно `openai`
- Model: `text-embedding-3-small`
- API key (опц., если тот же что chat — можно пустым оставить, валидация
  упадёт; нужно отдельно paste)
- **Embed dim**: 1536 для text-embedding-3-small, **обязательно**
  (vector dim в `kb_chunks` фиксирован при первом upload'е)

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
| `recruitment_generic` | Найм — новый лид → квалификация → интервью → оффер |
| `recruitment_uae_v1` | Специализированный шаблон для UAE/CIS-найма |
| `real_estate` | Заявки на недвижимость, запись на просмотры |
| `saas` | SaaS-продукт — demo request, квалификация |
| `video` | Видеопроизводство — бриф, KV, смета |
| `exchange` | Обменный пункт — крипта/RUB → THB наличные |

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

Добавить стадии и поля через drag-drop редактор на `/funnel`. Поддерживаемые
типы стадий: `form_fill`, `document_upload`, `rate_confirmation`, `awaiting_operator`,
`payment`, `waiting`, `interaction`, `assessment`, `milestone`.

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

### A. Onboarding checklist (на /dashboard)

```
✓ 1. Подключите канал           @acme_support_bot активен
✓ 2. Настройте LLM              openai / gpt-4o-mini
✓ 3. Загрузите документы в KB   Есть документы
```

`done=true` когда все три ✓ — checklist auto-hide.

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

Полный onboarding скриптом:

```bash
#!/usr/bin/env bash
set -euo pipefail
API="${API:-http://localhost:3000}"

# 1. Signup
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
| Signup → 409 conflict | Email или slug уже занят | Сменить email/slug |
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
| POST /channels → 402 "quota_exceeded" | План free лимит 1 канал | Upgrade на Starter / Pro через PlanWidget или DELETE старого канала |
| POST /kb/documents → 402 | Free план — 50 docs cap | Удалить старые docs или upgrade plan |
| Stripe Checkout → 503 "stripe_not_configured" | `STRIPE_SECRET_KEY` пустой на платформе | Set env STRIPE_SECRET_KEY + STRIPE_PRICE_STARTER + STRIPE_PRICE_PRO |
| После checkout план не обновился | Webhook не получен (нет STRIPE_WEBHOOK_SECRET или Stripe URL не указывает на /webhook/stripe) | Проверить Stripe dashboard → Webhooks → delivery attempts |

---

См. также [`ARCHITECTURE.md`](ARCHITECTURE.md) для глубже под капот.
