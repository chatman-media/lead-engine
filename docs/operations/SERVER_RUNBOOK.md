# Server runbook

Инструкция для обновления сервера после merge/push в `main`.

> **Авто-деплой настроен:** push в `main` → CI прогоняет тесты → GitHub Actions
> сам заходит по SSH и запускает `./deploy.sh`. Разовая настройка ключа и
> секретов — в [CD_SETUP.md](CD_SETUP.md). Шаги ниже — это то же самое вручную
> (для отката, дебага или деплоя с сервера напрямую через `./deploy.sh`).

> Полный список env-переменных — [../engineering/CONFIGURATION.md](../engineering/CONFIGURATION.md).

Текущая серверная разметка:

| Среда | Каталог | API port | Public URL | Admin UI |
|---|---|---:|---|---|
| Prod | `/opt/lead-engine` | 3000 | `https://exchanges.agency` | `https://client.exchanges.agency/` |
| Dev | `/opt/lead-engine-dev` | 3001 | `https://dev.exchanges.agency` | `https://dev.exchanges.agency/admin/` |

`https://exchanges.agency/admin` на prod должен отдавать 301 на
`https://client.exchanges.agency/`. `www.exchanges.agency` обслуживает тот же
лендинг, что и apex.

## 1. Перед обновлением

Проверить, что на сервере заданы обязательные env vars:

```bash
printenv DATABASE_URL
printenv PLATFORM_MASTER_KEY
printenv PLATFORM_PUBLIC_URL
```

Минимум:

- `DATABASE_URL` — PostgreSQL с pgvector.
- `PLATFORM_MASTER_KEY` — тот же ключ, которым шифровались tenant secrets.
- `PLATFORM_PUBLIC_URL` — публичный URL API для webhook/snippet.
- `TELEGRAM_WEBHOOK_SECRET` — если используются Telegram webhooks.

Для prod ожидается `PLATFORM_PUBLIC_URL=https://exchanges.agency` и
`ADMIN_UI_BASE=/`. Для dev ожидается
`PLATFORM_PUBLIC_URL=https://dev.exchanges.agency`; `ADMIN_UI_BASE` там не
задаём, потому что админка живёт под `/admin/`.

Нельзя менять `PLATFORM_MASTER_KEY` на живом сервере: старые зашифрованные
секреты перестанут расшифровываться.

## 2. Обновить код и зависимости

```bash
cd /opt/lead-engine
git fetch origin
git checkout main
git pull --ff-only origin main
bun install --frozen-lockfile
```

## 3. Применить миграции

```bash
DATABASE_URL="$DATABASE_URL" bun run apps/api/scripts/reset-and-migrate.ts --keep-data
```

Важно: без `--keep-data` этот dev/test-скрипт делает `DROP SCHEMA public
CASCADE`. На production/server запускать только с `--keep-data`. Для чистого
локального reset используем только `bun db:reset`.

## 4. Собрать приложения

```bash
bun run typecheck
bun run build:packages
bun run build:ui
bun run build:landing
bun run build:widget
```

Опционально перед рестартом:

```bash
DATABASE_URL="$DATABASE_URL" bun run --filter './apps/*' test
```

## 5. Перезапустить процессы

Пример для `systemd`:

```bash
sudo systemctl restart lead-engine-api
sudo systemctl restart lead-engine-worker
sudo systemctl status lead-engine-api --no-pager
sudo systemctl status lead-engine-worker --no-pager
```

> **Юнит обязан задавать `PATH` с `~/.bun/bin`.** `ExecStart=… bun run start`
> запускает вложенный `bun` через `/usr/bin/bash`, а у systemd-юнита PATH
> пустой → `bun: command not found` → `status=127` (краш-луп). В юните должно
> быть `Environment=PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
> (или drop-in `…/<svc>.service.d/path.conf`). Подробности и команда лечения —
> в [CD_SETUP.md](CD_SETUP.md) («Если упало»).

Проверить health:

```bash
curl -fsS "$PLATFORM_PUBLIC_URL/healthz"
```

## 6. Provider relay: feature flag и SQL-диагностика

Provider relay fail-closed: tenant не создаёт provider outreach, пока флаг
`provider_relay` явно не включён. (Диагностика через ops-эндпоинт — раздел 9.)

Включить/выключить для tenant:

```bash
TOKEN="<admin-jwt>"

curl -fsS -X PUT "$PLATFORM_PUBLIC_URL/api/admin/tenant/features/provider-relay" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'

curl -fsS "$PLATFORM_PUBLIC_URL/api/admin/tenant/features" \
  -H "Authorization: Bearer $TOKEN"
```

Ключевые метрики в `/metrics`:

- `lead_engine_provider_orders_created_total`
- `lead_engine_provider_requests_total`
- `lead_engine_provider_responses_total`
- `lead_engine_provider_time_to_quote_seconds`
- `lead_engine_provider_paid_orders_total`
- `lead_engine_provider_commission_earned_total`
- `lead_engine_provider_failures_total`

### Stuck provider orders

Симптомы: заказы долго остаются в `matching`, `awaiting_provider`,
`offer_ready` или `awaiting_customer_payment`; provider request не получает
quote/decline; customer offer не уходит.

Проверить активные заказы tenant'а:

```sql
BEGIN;
SET LOCAL app.tenant_id = :tenant_id;

SELECT id, request_type, status, payment_status, assigned_provider_id,
       created_at, updated_at
FROM service_orders
WHERE tenant_id = :tenant_id
  AND status IN ('matching','awaiting_provider','offer_ready','awaiting_customer_payment','paid','confirmed')
ORDER BY updated_at ASC
LIMIT 50;

SELECT pr.id, pr.order_id, pr.provider_id, pr.channel_id, pr.outbound_queue_id,
       pr.status, pr.sent_at, pr.responded_at, oq.status AS outbound_status,
       oq.last_error
FROM provider_requests pr
LEFT JOIN outbound_queue oq ON oq.id = pr.outbound_queue_id
WHERE pr.tenant_id = :tenant_id
  AND pr.status IN ('sent','seen','quoted','accepted','failed')
ORDER BY pr.updated_at ASC
LIMIT 50;

SELECT event_type, actor_type, data_json, created_at
FROM order_events
WHERE tenant_id = :tenant_id AND order_id = :order_id
ORDER BY created_at ASC, id ASC;

COMMIT;
```

Что делать:

- `outbound_queue.status='processing'` старше 5 минут: проверить worker logs;
  dispatcher должен вернуть stuck rows в `pending` через
  `releaseStuckProcessing`.
- `provider_requests.status='sent'`, но нет ответа: связаться с provider или
  назначить другого вручную; событие останется в `order_events`.
- `offer_ready` без customer offer: оператор должен approve/send offer, либо
  отменить order с причиной.
- `awaiting_customer_payment` без оплаты: проверить payment provider webhook и
  `service_order_payments`.

### WhatsApp provider send failures

Симптомы: растёт
`lead_engine_provider_failures_total{channel_kind="whatsapp",...}` или в order
timeline есть `provider_request_send_failed`.

Проверить последнюю ошибку:

```sql
BEGIN;
SET LOCAL app.tenant_id = :tenant_id;

SELECT pr.id, pr.order_id, pr.provider_id, pr.status, oq.last_error,
       pp.metadata_json
FROM provider_requests pr
JOIN provider_profiles pp ON pp.id = pr.provider_id
LEFT JOIN outbound_queue oq ON oq.id = pr.outbound_queue_id
WHERE pr.tenant_id = :tenant_id
  AND pr.status = 'failed'
ORDER BY pr.updated_at DESC
LIMIT 20;

COMMIT;
```

Чеклист:

- provider profile содержит `whatsappOptIn.acceptedAt` и разрешённые категории;
- `whatsappProviderRequestTemplate.name/languageCode` заполнены;
- `whatsappProviderRequestTemplate.approved=true`;
- Meta template реально approved в WhatsApp Manager и совпадает по language/name;
- `WA_ACCESS_TOKEN` / tenant secret действителен, phone number id совпадает с
  `channels.external_id`;
- после исправления шаблона создать новый provider request или manual override;
  старый failed request не должен молча переотправляться без operator decision.

## 7. Обновить exchange funnel для tenant

После изменений exchange workflow нужно переустановить шаблон `exchange`, чтобы
в админке появились все бизнес-шаги:

```bash
TOKEN="<admin-jwt>"

curl -fsS -X POST "$PLATFORM_PUBLIC_URL/api/admin/funnel/seed" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template":"exchange"}'
```

Ожидаемый ответ после актуального deploy:

```json
{ "ok": true, "funnelId": 123, "stagesCreated": 12 }
```

Если вернулось `stagesCreated: 7`, значит применился не `exchange`, а другой
шаблон (например `visa`) или на сервере ещё старый backend. Перезапустить API
после pull/build и повторить запрос.

Важно: seed заменяет активную funnel-структуру tenant'а. Если на проде воронку
правили вручную, сначала экспортировать/зафиксировать текущие стадии через:

```bash
curl -fsS "$PLATFORM_PUBLIC_URL/api/admin/funnel" \
  -H "Authorization: Bearer $TOKEN"
```

## 8. Проверить exchange CRM

В админке открыть `/exchange` и проверить:

- заявки отображают технический `status`;
- рядом виден бизнес-шаг `workflowStage` (`Ожидание оплаты`, `Проверка чека`,
  `Выдача / Завершено`);
- `/funnel` после выбора шаблона `Обменный пункт · 11` показывает 11 стадий;
- курсы и формулы открываются без ошибок;
- сохранённые реквизиты доступны через exchange tools.

Если `workflowStage` не виден, проверить, что UI был пересобран и задеплоен.

## 9. Provider relay: ops-эндпоинт и инциденты

Provider relay управляет заказами, где клиент пишет в один канал, оператор
матчит провайдера, а провайдер получает запрос в своём канале. На alpha это
включается tenant-by-tenant через feature flag (см. раздел 6 — включение флага
и SQL-диагностика).

Проверить флаг и операционные метрики:

```bash
TOKEN="<admin-jwt>"

curl -fsS "$PLATFORM_PUBLIC_URL/api/admin/provider-orders/ops" \
  -H "Authorization: Bearer $TOKEN"
```

В ответе смотреть:

- `settings.enabled` — можно ли выполнять operator actions;
- `metrics.ordersCreated` — созданные service orders;
- `metrics.providerResponseRatePct` и `metrics.avgTimeToQuoteSec` — отвечает ли
  провайдерский слой;
- `metrics.paidOrders`, `metrics.commissionAmountTotal`,
  `metrics.paidCommissionAmount` — деньги и комиссия;
- `metrics.failuresByChannel` — ошибки доставки по каналам;
- `metrics.stuckOrders.items` — зависшие заказы с `reason` и `dueAt`.

Временно выключить relay для tenant:

```bash
curl -fsS -X PUT "$PLATFORM_PUBLIC_URL/api/admin/provider-orders/ops/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Вернуть обратно:

```bash
curl -fsS -X PUT "$PLATFORM_PUBLIC_URL/api/admin/provider-orders/ops/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

### Зависшие заказы

1. Вызвать `/api/admin/provider-orders/ops` и взять
   `metrics.stuckOrders.items`.
2. Открыть деталь заказа:

```bash
curl -fsS "$PLATFORM_PUBLIC_URL/api/admin/provider-orders/<order-id>" \
  -H "Authorization: Bearer $TOKEN"
```

3. Если `reason=quote_expired`, проверить последний `providerRequests[].status`,
   `quoteExpiresAt`, `outboundStatus`, `outboundLastError`.
4. Если провайдер не ответил, отправить новый запрос через UI или API
   `POST /api/admin/provider-orders/<order-id>/send-provider-request`.
5. Если клиент отменил или заказ протух, закрыть через
   `POST /api/admin/provider-orders/<order-id>/cancel`.
6. Проверить `events[]`: должны быть видны `provider_request_sent`,
   `provider_quoted`, `customer_offer_sent`, `order_cancelled` или
   `order_fulfilled`.

### WhatsApp send failures

Если `metrics.failuresByChannel.whatsapp > 0`:

1. Открыть проблемный order detail и найти `providerRequests[]` с
   `outboundStatus=failed` или событие `provider_request_send_failed`.
2. Проверить `outboundLastError`: чаще всего это невалидный provider opt-in,
   template outside 24h window, неверный phone number id или истёкший token.
3. Проверить channel в админке: WhatsApp channel должен быть `active`, а secret
   должен расшифровываться тем же `PLATFORM_MASTER_KEY`.
4. Перезапустить worker только после исправления channel/secret:

```bash
sudo systemctl restart lead-engine-worker
sudo journalctl -u lead-engine-worker -n 200 --no-pager
```

5. Повторить `send-provider-request` для affected order. Если ошибка
   повторяется, выключить relay feature flag для tenant и вести заказы вручную
   до исправления канала.
