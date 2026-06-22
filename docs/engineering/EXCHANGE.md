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
  `deviation_pct` (источник истины для спреда), `display_rate` (текущий
  пересчитанный снимок для клиента), `market_rate` (live-референс).
  Перекрывают базовый курс в своём диапазоне.
- **`exchange_settings`** — per-tenant настройки (нет строки → дефолты):
  `rate_refresh_sec` (как часто планировщик обновляет auto-курсы; дефолт 180с, пол
  60с, потолок 86400с) и `feed_stale_sec` (порог `rate_feed_stale`; NULL → авто
  `max(env, 3 × refresh)`); `require_rate_confirmation` (тумблер «не применять курс
  с фида автоматически» — см. ниже); `round_steps` (jsonb per-currency округление
  выплаты — см. [Округление выплаты](#округление-выплаты-per-currency-round-steps));
  `quote_asset` (валюта котировки тенанта). Планировщик — тик `min(RATE_FEED_MS, 60с)`
  + per-tenant due-check (last-refresh в памяти процесса; на рестарте рефрешит всех).
  `RATE_FEED_MS` env → дефолт + `0` отключает. UI выбора частоты (5м–4ч) — вкладка
  «Курсы» в админке.

`computeQuote()` (`rates.ts`): для монет режим **multiply** (THB за 1 asset), для
фиата **divide** (source за 1 THB); применяет маржу/комиссию, округляет по decimals.
Сумму выплаты дополнительно округляет **вниз** по `round_steps` под выбранный способ
выдачи (atm/cash/bank).

## Предложения курса (rate proposals)

`apps/api/src/lib/exchange/rate-feed.ts`, таблица `exchange_rate_proposals`
(миграция `0078`). Когда фид возвращает курс с заметным отклонением **или** включён
`require_rate_confirmation`, новый `baseRate` **не** применяется к `exchange_rates`
сразу — кладётся pending-предложение для оператора:

- отклонение `< soft` и тумблер выключен → авто-применение (без предложения);
- `soft ≤ dev < hard` **или** `require_rate_confirmation=true` → pending-предложение
  (`severity=soft`); один открытый proposal на направление (partial unique index,
  новый сэмпл фида перетирает прошлый);
- `dev ≥ hard` → курс замораживается (`rate_anomaly`) + `severity=hard` proposal.

Пороги — env `FEED_SOFT_DEVIATION` / `FEED_MAX_DEVIATION`. Пока proposal висит, бот
котирует по старому (активному) курсу. Оператор подтверждает/отклоняет в админке
(вкладка «Курсы») → `POST /api/admin/exchange/rate-proposals/:id/{confirm,reject}`;
confirm применяет `next_base_rate` и пересчитывает тиры (`applyBaseRateToTiers`),
ловит гонку (если активный курс уже сдвинулся → `409 stale`).

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

## KYC / верификация

Статус KYC хранится в `contacts.attributes_json.exchangeKyc`
(`{ status, verified, needsVerification, verificationId, reviewedByAdminId,
reviewedAt, source }`); legacy-фоллбэк — `isVerified`/`verificationStatus`.
Гейт обмена смотрит на этот статус (`getExchangeVerificationStatus`), а не на
стадию — поэтому, как только KYC `verified`, бот сам идёт дальше.

На KYC-стадии бот просит документ + видео-кружок. Любое медиа в exchange-диалоге
(`mode='ai'`) авто-эскалирует на оператора (`kyc_review`, `processInbound`).
Подтверждают KYC двумя путями:

- **Operator-бот** (Telegram) — callback `kycok` → мгновенное одобрение.
- **Админка, страница «Диалоги»** (#699) — кнопка «✅ Подтвердить KYC» в
  KYC-панели: `POST /api/admin/conversations/:id/kyc/approve` ставит
  `exchangeKyc.verified` (через `moderateConversationContact`) и возвращает
  диалог в AI-режим. Работает и для реальных клиентов, не только симуляции.

Отзыв/разблокировка KYC — `POST /api/admin/leads/:id/verification/{revoke,unblock}`.

## Реквизиты

Шифрованные `tenant_secrets` через allowlist
`apps/api/src/lib/exchange/requisite-keys.ts`:

- **Кошельки**: префикс `exchange_wallet_` + `<asset>_<network>`.
- **Фиксированные платёжные ключи**: `exchange_fiat_payment_url`,
  `exchange_binance_id`, `exchange_rub_card_requisites`.
- **Бизнес-данные**: `exchange_operator_contact`, `exchange_payout_methods`,
  `exchange_kyc_policy`, `exchange_working_hours`, `exchange_office_address`.

## Точки выдачи и ATM-карта

`apps/api/src/lib/exchange/payout-points.ts`, таблица `exchange_payout_points`
(миграция `0075`). Структурная замена свободной строки `exchange_orders.payout_location`:
каталог точек, где клиент забирает наличные.

- `kind` ∈ `atm | office | courier_zone`; `code` (стабильный slug), `label`,
  `bank_name`, `quote_asset`, гео (`lat`/`lng`/`city`/`address`), `is_active`.
- `denomination` — шаг номинала: выдача округляется **вниз** кратно ему (NULL →
  дефолт тенанта из `round_steps` / словаря валюты).
- `per_withdrawal_max` — лимит одного cardless-снятия; сумма выше дробится на
  несколько кодов. `code_ttl_sec` — TTL кода/ваучера. `fee_fixed`/`fee_pct` —
  комиссия выдачи/курьера.
- `source` (`manual | feed`) + `external_id` — upsert при синке из OSM.

**Бот** видит точки через тул `list_exchange_payout_points` (`tools.ts`): по гео
клиента (+`radius_km`, дефолт 5) и `kind` возвращает ближайшие, отфильтрованные по
поддерживаемым банкам тенанта (`exchange_payout_banks`).

**Админка** (вкладка обменника, `SaasExchange.tsx`): реальная карта на Leaflet+OSM —
переключатель слоёв (Тёмная / Дороги / Спутник), маркеры с цветом по банку и
фильтр-тогглы по банкам; кнопка «Синк OSM» подтягивает банкоматы автоматически.

Endpoints (`admin-exchange.ts`):

```
GET    /api/admin/exchange/payout-points              — список
POST   /api/admin/exchange/payout-points              — создать
PATCH  /api/admin/exchange/payout-points/:id          — изменить
DELETE /api/admin/exchange/payout-points/:id          — деактивировать
POST   /api/admin/exchange/payout-points/:id/send-location — послать гео клиенту в Telegram
POST   /api/admin/exchange/payout-points/sync-osm     — авто-синк из OpenStreetMap
```

## Покрытие операторов (operator coverage)

`operator_payout_coverage` (миграция `0076`) — M:N между `admins` и
`exchange_payout_points`: какой оператор может выдать через какую точку. Хелпер
`listCoveringOperatorAdminIds()` (`payout-points.ts`) отдаёт пул адмов под точку;
`pickLeastBusyOperator` (`packages/conversation-engine`) при хэндоффе выдачи
сужает кандидатов до покрывающих (если их нет — фолбэк на общий пул) и берёт
наименее загруженного. Endpoints под точкой:

```
GET    /api/admin/exchange/payout-points/:id/coverage           — кто покрывает
POST   /api/admin/exchange/payout-points/:id/coverage           — назначить оператора
DELETE /api/admin/exchange/payout-points/:id/coverage/:adminId  — снять
```

## Округление выплаты (per-currency round steps)

`exchange_settings.round_steps` — jsonb, ключ = ISO-код валюты, значение =
`{ atm?, cash?, bank? }` (миграции `0080`→`0081`→`0082`: три integer-колонки
схлопнуты в один jsonb). Читается в `computeQuote()` (`rates.ts`): по способу
выдачи берётся `round_steps[quoteAsset].{atm|cash|bank}`, иначе дефолт из словаря
валюты (`packages/verticals`), и сумма округляется вниз кратно шагу. `denomination`
конкретной точки выдачи перекрывает этот дефолт. Задаётся через
`PUT /api/admin/exchange/settings` (валидация: код валюты известен, шаг ≥ 1) +
UI на вкладке «Курсы».

## Мультиязык (PH-локализация)

Эпик #728. Платформенный механизм (не только обмен), driven обменом под Филиппины.

- **Детект языка** — `packages/conversation-engine/src/language.ts`:
  Unicode-эвристика (`detectScriptLang`: кириллица→ru, латиница→en, хангыль→ko,
  хань→zh), `resolveConversationLang` лочит язык на уверенном сигнале и хранит в
  `conversations.detected_lang` / `lang_locked` (миграция `0077`); `effectiveLang`
  каскадит detected → дефолт тенанта → en.
- **Перевод** — `packages/conversation-engine/src/translation.ts` (LLM через
  инжектируемый ChatClient, `OPERATOR_LANG='ru'`). Перевод хранится 1:1 на строке
  сообщения: `messages.orig_lang` / `translated_text` / `translated_lang`
  (миграция `0079`) — кэш, чтобы не переводить повторно.
- **Поток оператора** (`admin-conversations.ts`): входящие реплики клиента лениво
  переводятся на RU при открытии диалога; ответ оператора (RU) переводится обратно
  на язык клиента перед отправкой. Оба перевода кэшируются на сообщении.

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
GET    /api/admin/exchange/settings              — частота/порог фида + require_rate_confirmation + round_steps
PUT    /api/admin/exchange/settings              — задать частоту (60..86400с), порог, подтверждение курса, round_steps
POST   /api/admin/exchange/rate-card/preview     — превью тиров (снимок рынка)
POST   /api/admin/exchange/rate-card/approve     — применить тиры
GET    /api/admin/exchange/rate-proposals        — pending-предложения курса
POST   /api/admin/exchange/rate-proposals/:id/confirm — применить предложенный курс
POST   /api/admin/exchange/rate-proposals/:id/reject  — отклонить
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

## Симулятор диалогов

`apps/api/src/routes/admin-sim.ts` (+ кнопка на странице «Диалоги»). LLM играет
клиента: каждая реплика прогоняется через НАСТОЯЩИЙ `processInbound` (persist +
stage + extract), ответ даёт `replyStrategy.generate()`. Диалог помечается
`source='self_play'`, виден в живом инбоксе, в Telegram ничего не уходит.

- **Управляемые сценарии (#698)** — таблица `sim_personas` (миграция `0073`).
  Встроенные ~25 персон сидятся per-tenant идемпотентно из кода
  (`ensureBuiltinPersonas`, по `persona_key`, правки оператора не перетираются),
  кастомные — полный CRUD из админки: `GET/POST/PATCH/DELETE
  /api/admin/sim/personas`. Встроенные можно редактировать, но не удалять.
- **Mock KYC-медиа (#699 / #716)** — когда бот просит верификацию, sim-клиент на
  следующем ходу «присылает» mock-паспорт (`photo`) + видео-кружок
  (`video_note`); срабатывает штатная `kyc_review`-эскалация на оператора, далее
  оператор подтверждает KYC из инбокса (см. выше).
- **Scripted-диалоги (#768)** — детерминированный прогон **записанных** реальных
  диалогов без LLM-клиента. Markdown-кейсы из
  `apps/vertical-exchange/evals/exchange-candidate-cases/` (корень → THB, `ph/` →
  PHP) парсятся `scripted-dialogs.ts` в реплики + медиа-маркеры (`[фото]`/`[файл]`/
  `[голосовое]`) и проигрываются через живой `processInbound`: `GET
  /api/admin/sim/scripts?currency=THB|PHP` — список, `POST /api/admin/sim/replay
  { scriptId, currency?, displayName?, languageCode? }` — прогон (первый ход
  синхронно отдаёт `conversationId`, остальные в фоне). В отличие от LLM-персон —
  ноль токенов и воспроизводимость; в инбоксе помечен `▶ {title}`. Файлы читаются
  с диска в рантайме (доставляются `git pull`).

## Карта файлов

| Что | Где |
|---|---|
| Шаблон вертикали + стадии | `apps/vertical-exchange/src/` |
| Курсы/котировки + round_steps | `apps/api/src/lib/exchange/rates.ts` |
| Фид курсов + предложения | `apps/api/src/lib/exchange/rate-feed.ts` |
| Guardrails | `apps/api/src/lib/exchange/guardrails.ts` |
| Реквизиты (allowlist) | `apps/api/src/lib/exchange/requisite-keys.ts` |
| Заявки | `apps/api/src/lib/exchange/orders.ts` |
| Точки выдачи + покрытие + тулы | `apps/api/src/lib/exchange/payout-points.ts`, `tools.ts` |
| Scripted-диалоги (парсер/загрузчик) | `apps/api/src/lib/exchange/scripted-dialogs.ts` |
| Мультиязык (детект/перевод) | `packages/conversation-engine/src/{language.ts,translation.ts}` |
| Маршрутизация выдачи на оператора | `packages/conversation-engine` (`pickLeastBusyOperator`) |
| Admin API | `apps/api/src/routes/admin-exchange.ts` |
| KYC-подтверждение + перевод (инбокс) | `apps/api/src/routes/admin-conversations.ts` |
| Симулятор + сценарии + replay | `apps/api/src/routes/admin-sim.ts`, миграция `0073_sim_personas.sql` |
| ATM-карта (Leaflet+OSM) | `apps/admin-ui/src/pages/SaasExchange.tsx` |
| Ops-watch sweeper | `apps/worker/src/ops-watch-sweep.ts` |
| Миграции (база) | `0022_exchange.sql`, `0025_exchange_rate_tiers.sql`, `0026_exchange_order_methods.sql` |
| Миграции (свежие) | `0071` подписи полей, `0074` intake-ask-all, `0075` payout points, `0076` operator coverage, `0077` detected_lang, `0078` rate proposals, `0079` message translations, `0080`–`0082` round_steps jsonb |
| E2E-кейсы | `apps/vertical-exchange/evals/exchange-candidate-cases/` (корень → THB, `ph/` → PHP) |

Прод re-seed/verify воронки — [operations/SERVER_RUNBOOK.md](../operations/SERVER_RUNBOOK.md).
