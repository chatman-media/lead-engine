# Server runbook

Инструкция для обновления сервера после merge/push в `main`.

> **Авто-деплой настроен:** push в `main` → CI прогоняет тесты → GitHub Actions
> сам заходит по SSH и запускает `./deploy.sh`. Разовая настройка ключа и
> секретов — в [CD_SETUP.md](CD_SETUP.md). Шаги ниже — это то же самое вручную
> (для отката, дебага или деплоя с сервера напрямую через `./deploy.sh`).

> Полный список env-переменных — [../engineering/CONFIGURATION.md](../engineering/CONFIGURATION.md).

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

Проверить health:

```bash
curl -fsS "$PLATFORM_PUBLIC_URL/healthz"
```

## 6. Обновить exchange funnel для tenant

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

## 7. Проверить exchange CRM

В админке открыть `/exchange` и проверить:

- заявки отображают технический `status`;
- рядом виден бизнес-шаг `workflowStage` (`Ожидание оплаты`, `Проверка чека`,
  `Выдача / Завершено`);
- `/funnel` после выбора шаблона `Обменный пункт · 12` показывает 12 стадий;
- курсы и формулы открываются без ошибок;
- сохранённые реквизиты доступны через exchange tools.

Если `workflowStage` не виден, проверить, что UI был пересобран и задеплоен.
