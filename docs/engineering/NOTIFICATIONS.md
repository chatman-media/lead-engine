# Notifications & stage webhooks

Два независимых механизма «сообщить наружу о событии лида»:

1. **Stage webhooks** — HTTP POST на URL тенанта при смене стадии (интеграции).
2. **Notifications** — уведомления оператору/в Telegram-группу по правилам
   (+ шаблоны, operator settings, ops-алерты обменника).

## 1. Stage webhooks

Таблица `stage_webhooks` (миграция `0014_stage_webhooks.sql`): `url`,
`secret` (опц.), `is_active`. При каждом `lead.stage_changed` API шлёт `POST`
с JSON-payload и опциональной HMAC-подписью (если задан `secret`).

`apps/api/src/routes/admin-stage-webhooks.ts`:

```
GET    /api/admin/stage-webhooks         — список
POST   /api/admin/stage-webhooks         — создать { url, secret? }
PATCH  /api/admin/stage-webhooks/:id     — обновить (url/secret/is_active)
DELETE /api/admin/stage-webhooks/:id     — удалить
POST   /api/admin/stage-webhooks/:id/test — тестовая доставка
```

## 2. Notifications

`apps/api/src/routes/admin-notifications.ts`, смонтирован на
`/api/admin/notifications`. Использует `notificationService` + `opsAlertRouter`.

### Правила (`notification_rules`, миграция 0019)

Поля: `event_type`, `condition_json` (фильтр), `channel_type` (дефолт
`telegram_group`), `target_id`, `priority` (`normal`…), `is_active`.

```
GET    /api/admin/notifications/rules         — список правил
POST   /api/admin/notifications/rules         — создать правило
DELETE /api/admin/notifications/rules/:id     — удалить
POST   /api/admin/notifications/rules/:id/test — тест-отправка
```

### Шаблоны (`notification_templates`, миграция 0019)

`slug` + `body`, уникальны per-tenant. Текст сообщения для события.

```
GET    /api/admin/notifications/templates        — список
PUT    /api/admin/notifications/templates/:slug  — upsert
DELETE /api/admin/notifications/templates/:slug  — удалить
```

### Operator settings (`operator_settings`, миграция 0019)

Per-admin: `telegram_chat_id`, `link_token` (+ `link_token_expires_at`),
`notify_on_assigned_only` (дефолт true — слать только по назначенным лидам).

```
GET    /api/admin/notifications/settings       — настройки текущего оператора
PUT    /api/admin/notifications/settings        — обновить
POST   /api/admin/notifications/settings/link   — выдать link-token для привязки
                                                  личного Telegram (deep-link к боту)
```

### Привязка Telegram-группы (`notification_group_tokens`, миграция 0020)

Одноразовый `token` (с `expires_at`, `event_type` дефолт `stage_changed`) —
оператор добавляет бота в группу и активирует токен, чтобы уведомления шли
в группу.

```
POST   /api/admin/notifications/group-link      — сгенерировать токен привязки группы
```

### Ops-алерты (обменник)

Интеграция с ops-watch sweeper (см. [EXCHANGE.md](EXCHANGE.md#ops-watch-алерты-владельцу)):

```
GET    /api/admin/notifications/ops-status      — текущее состояние ops-аномалий
POST   /api/admin/notifications/ops-test        — тестовый ops-алерт
```

## Карта файлов

| Что | Где |
|---|---|
| Stage webhooks API | `apps/api/src/routes/admin-stage-webhooks.ts` |
| Notifications API | `apps/api/src/routes/admin-notifications.ts` |
| Доставка/сервис | `notificationService`, `opsAlertRouter` (wired в `apps/api/src/index.ts`) |
| Миграции | `0014_stage_webhooks.sql`, `0019_notifications.sql`, `0020_notification_group_tokens.sql` |

Бот-имя для deep-link — `cfg.operatorBotUsername`. Аудит — все изменения в
`audit_log` (см. [ARCHITECTURE.md](ARCHITECTURE.md)).
