# Exchange vertical

Крипто/нал обменник (`exchange_v1`) — основная live-вертикаль. Этот док
консолидирует то, что раньше было разбросано по ARCHITECTURE / ONBOARDING /
SERVER_RUNBOOK. Онбординг обменного тенанта (визард) — см.
[ONBOARDING.md](ONBOARDING.md); общий костяк фаз —
[ARCHITECTURE.md#funnel-phase-backbone](ARCHITECTURE.md).

## Воронка (11 стадий)

`apps/vertical-exchange/src/funnel-stages.ts`. Стадии и их фаза костяка:

| Стадия | kind | phase |
|---|---|---|
| `exchange_request` | intake | capture |
| `quote_calculated` | active | offer |
| `verification_check` | active | clear |
| `kyc_collection` (опц.) | active | clear |
| `risk_review` | active | clear |
| `order_created` | active | fulfill |
| `requisites_sent` | active | fulfill |
| `payment_proof_waiting` | active | fulfill |
| `payment_verified` | active | fulfill |
| `payout_or_completion` | terminal_won | won |
| `cancelled` | terminal_lost | lost |

Поток: клиент → параметры обмена → котировка → верификация/KYC/риск → заявка →
реквизиты → подтверждение оплаты → проверка → выплата.

## Курсы и котировки

`apps/api/src/lib/exchange/rates.ts`. Две таблицы:

- **`exchange_rates`** — базовый курс на `asset`+`network`: `quoteMode`
  (`multiply`/`divide`), `marginPct`, `feeFixedThb`, мин/макс суммы, флаг
  авто-обновления с рыночного фида (`rate-feed`).
- **`exchange_rate_tiers`** — approved объёмные ступени: `targetThb`,
  `display_rate` (показывается клиенту), `market_rate` (live-референс),
  отклонение от рынка. Перекрывают базовый курс в своём диапазоне.
- **`exchange_settings`** — per-tenant настройки фида (нет строки → дефолты):
  `rate_refresh_sec` (как часто планировщик обновляет auto-курсы; дефолт 180с, пол
  60с) и `feed_stale_sec` (порог `rate_feed_stale`; NULL → авто `max(env, 3 × refresh)`).
  Планировщик — тик `min(RATE_FEED_MS, 60с)` + per-tenant due-check (last-refresh в
  памяти процесса; на рестарте рефрешит всех). `RATE_FEED_MS` env → дефолт + `0` отключает.

`computeQuote()`: для монет режим **multiply** (THB за 1 asset), для фиата
**divide** (source за 1 THB); применяет маржу/комиссию, округляет по decimals.

## Guardrails

`apps/api/src/lib/exchange/guardrails.ts`. Синхронный `checkRateGuard()`:
эффективный курс не должен отклоняться от базового больше `maxDeviationPct`
(дефолт **35%**). Ловит опечатки тарифа («10 вместо 35» → −71%) и мусор из
фида. Применяется и к tier `display_rate` (раньше тиры обходили guardrails).

## Ops-watch (алерты владельцу)

`apps/worker/src/ops-watch-sweep.ts`. Периодический sweeper детектит 4 аномалии:

| Kind | Триггер |
|---|---|
| `rate_feed_stale` | авто-курсы давно не обновлялись (фид мёртв) |
| `order_stuck` | заявка зависла в `paid`/`payout` |
| `channel_down` | канал в `error` (бот молчит лидам) |
| `volume_spike` | оборот за час выше порога (опц., off по умолчанию) |

Эмитит `OpsAlert` (tenant, kind, severity, dedup-key) с cooldown'ом
(`OPS_ALERT_COOLDOWN_MIN`). Доставка/тест — через notifications
(`/api/admin/notifications/ops-status`, `/ops-test`, см.
[NOTIFICATIONS.md](NOTIFICATIONS.md)).

## Реквизиты

Шифрованные `tenant_secrets` через allowlist
`apps/api/src/lib/exchange/requisite-keys.ts`:

- **Кошельки**: префикс `exchange_wallet_` + `<asset>_<network>`.
- **Фиксированные платёжные ключи**: `exchange_fiat_payment_url`,
  `exchange_binance_id`, `exchange_rub_card_requisites`.
- **Бизнес-данные**: `exchange_operator_contact`, `exchange_payout_methods`,
  `exchange_kyc_policy`, `exchange_working_hours`, `exchange_office_address`.

## Deterministic QA fixtures

Для локального preview/eval обменки есть идемпотентный seed:

```sh
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-fixtures -- --tenant=<tenant-slug>
```

Dry-run:

```sh
bun run --cwd apps/api seed:exchange-fixtures -- --tenant=<tenant-slug> --dry-run
```

Seed пишет всё tenant-scoped через `withTenant()`:

- offices: `bangkok_asok`, `phuket_central`, `pattaya_terminal_21`,
  `samui_chaweng`;
- rates: `USDT/TRC20`, `USDT/ERC20`, `USDT/BEP20`, `RUB`, `USD`;
- approved tiers для `USDT/TRC20` и `RUB`;
- encrypted requisites/business secrets: RUB card/SBP, USDT wallets, operator
  contacts, payout methods, AML/KYC policy, working hours, office list;
- text-only KB docs for office pickup, RUB payment proof, KYC media, stale
  rates/order changes, and operator escalation.

Registry and helper live in
`apps/api/src/lib/exchange/fixtures.ts`. Scenario/eval code should reference the
exported fixture keys instead of hardcoding addresses, offices, rates, or policy
copy in every test.

## Demo tenant seed

Для клиентского показа есть сид демо-тенанта обменки под ключ:

```sh
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo
```

По умолчанию создаётся/обновляется tenant `exchange-demo`, owner
`owner@exchange.demo`, operator `operator@exchange.demo`, пароль `test1234`.
Сид поднимает active tenant, web-channel, chat LLM config для onboarding gate,
воронку `exchange` с `vertical_template_id='exchange_v1'`, deterministic
fixtures, KB из `apps/api/kb-samples/exchange`, а также демо-лиды/диалоги/заявки
по стадиям exchange workflow.

Для живого Telegram-демо передайте токен только через env/флаг; он будет
зашифрован в `tenant_secrets`, а в `channels.credentials_ref` останется только
ссылка:

```sh
EXCHANGE_DEMO_TELEGRAM_BOT_TOKEN=123:ABC... \
EXCHANGE_DEMO_TELEGRAM_BOT_USERNAME=my_demo_bot \
PLATFORM_PUBLIC_URL=https://api.example.com \
TELEGRAM_WEBHOOK_SECRET=<secret> \
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
PLATFORM_MASTER_KEY=<64hex> \
bun run --cwd apps/api seed:exchange-demo -- --set-telegram-webhook
```

После запуска проверить `/api/admin/diagnostics` от owner-админа. Без реального
Telegram token сид оставляет web-канал и все кабинетные данные готовыми, но live
Telegram webhook нужно подключить отдельно.

GTM-документы для показа обменнику живут в
[`../gtm/exchange/README.md`](../gtm/exchange/README.md): demo script,
screen sequence, objections, alpha trial flow и live-demo runbook для #495.

## Orders CRM

`exchange_orders` — заявки с привязкой к лиду, статусом, суммами и платёжными
рельсами. Оператор патчит статус/метаданные; есть оборот (turnover).

## Admin endpoints

`apps/api/src/routes/admin-exchange.ts`:

```
GET    /api/admin/exchange/rates                 — список базовых курсов
POST   /api/admin/exchange/rates                 — upsert базового курса
DELETE /api/admin/exchange/rates/:id             — отключить
POST   /api/admin/exchange/rates/refresh         — форс-обновление с фида
GET    /api/admin/exchange/settings              — per-tenant частота/порог фида
PUT    /api/admin/exchange/settings              — задать частоту (60..86400с) + порог
POST   /api/admin/exchange/rate-card/preview     — превью тиров (снимок рынка)
POST   /api/admin/exchange/rate-card/approve     — применить тиры
GET    /api/admin/exchange/requisites            — реквизиты (decrypted)
POST   /api/admin/exchange/requisites            — сохранить реквизит
GET    /api/admin/exchange/orders                 — список заявок
GET    /api/admin/exchange/orders/:id             — заявка
PATCH  /api/admin/exchange/orders/:id             — operator patch
GET    /api/admin/exchange/turnover               — оборот
```

Все под `withTenant()` RLS, трекают `updatedByAdminId` / `approvedByAdminId`.

## QR / фото клиенту

`POST /api/admin/leads/:id/send-photo { photoRef, caption? }` — оператор
шлёт cardless-withdrawal QR клиенту (Telegram `file_id` или HTTPS URL),
ставит `outbound_queue kind="photo"`. Подробнее в ARCHITECTURE.

## Карта файлов

| Что | Где |
|---|---|
| Шаблон вертикали + стадии | `apps/vertical-exchange/src/` |
| Курсы/котировки | `apps/api/src/lib/exchange/rates.ts` |
| Guardrails | `apps/api/src/lib/exchange/guardrails.ts` |
| Реквизиты (allowlist) | `apps/api/src/lib/exchange/requisite-keys.ts` |
| Заявки | `apps/api/src/lib/exchange/orders.ts` |
| Admin API | `apps/api/src/routes/admin-exchange.ts` |
| Ops-watch sweeper | `apps/worker/src/ops-watch-sweep.ts` |
| Миграции | `0022_exchange.sql`, `0025_exchange_rate_tiers.sql`, `0026_exchange_order_methods.sql` |
| E2E-кейсы | `apps/vertical-exchange/evals/exchange-candidate-cases/` |

Прод re-seed/verify воронки — [operations/SERVER_RUNBOOK.md](../operations/SERVER_RUNBOOK.md).
