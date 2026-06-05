# Web widget

Встраиваемый чат-виджет для сайта (канал `kind='web'`). Один тег `<script>` →
плавающий «пузырь» → WebSocket к apps/api → тот же inbound-pipeline, что у
Telegram/WhatsApp. Outbound идёт **в процессе apps/api** (pinned WS), не через
worker.

## Бандл

`apps/widget` — Vite ESM-бандл без фреймворка, цель ~10–15 КБ gzip. Сборка →
`dist/widget.js` (+ source map). Раздаётся `GET /widget.js` из apps/api, либо с
CDN через env `WEB_WIDGET_SCRIPT_URL`.

| Файл | Роль |
|---|---|
| `src/index.ts` | boot + парсинг конфига; экспорт `mountWidget(cfg)`; idempotency-флаг `__leadEngineWidgetInit__` (защита от двойного монтирования) |
| `src/widget.ts` | UI: пузырь (SVG), раскрывающаяся панель, история (shadow DOM) |
| `src/ws-client.ts` | WebSocket + авто-reconnect (экспоненциальный backoff 1с→30с) |
| `src/styles.ts` | генерация CSS, инжект брендового цвета |

Состояние: `localStorage` — userId + история (последние ~50 на диалог);
`sessionStorage` — открыта/закрыта панель.

## Embed-сниппет

`apps/api/src/routes/admin-channels.ts` → `generateWebWidgetSnippet()`. Создаётся
через `POST /api/admin/channels/web { externalId?, brandName?, primaryColor? }`,
который заводит `channels(kind='web', ...)` и возвращает готовый сниппет +
`wsUrl` + `demoUrl` (smoke-test `/demo/web-chat.html`):

```html
<!-- lead-engine chat widget — перед </body> -->
<script async src="<scriptSrc>"
  data-slug="<externalId>"
  data-host="https://api.example.com"
  data-brand="Имя бренда"
  data-color="#6aa6ff"
  data-auth="REPLACE_WITH_USER_JWT"></script>
```

| data-атрибут | Обяз. | Значение |
|---|---|---|
| `data-slug` | да | externalId веб-канала |
| `data-host` | да | базовый URL apps/api |
| `data-brand` | нет | заголовок виджета (дефолт «Чат-бот») |
| `data-color` | нет | акцент `#rgb`/`#rrggbb` (дефолт `#6aa6ff`) |
| `data-auth` | нет | токен для WS-auth (см. ниже) |

`brandName`/`primaryColor` сохраняются в `channels.metadataJson`. Если задан
`WEB_WIDGET_SCRIPT_URL` — в `src` подставляется CDN-URL, иначе
`<PLATFORM_PUBLIC_URL>/widget.js`.

## WebSocket lifecycle

`apps/api/src/routes/ws-web.ts`, URL `/ws/<slug>?user=<userId>&auth=<token>`:

```
tryUpgrade: парс slug + query (user обяз., 1–128 симв.)
            если задан WEB_WS_AUTH_SECRET → auth должен совпасть (иначе reject)
            lookup в WebChannelRegistry → server.upgrade → 101
open:       adapter.acceptConnection(ws, userId) → кадр { type:"ready", channelId, userId }
message:    adapter.onClientFrame(userId, text)
close:      adapter.onDisconnect(userId)
```

Auth — shared-secret `WEB_WS_AUTH_SECRET` (pilot). Пусто = открытый доступ
(только dev/staging). Прод: JWT в `data-auth` — следующая итерация.

## Протокол

`packages/channel-web/src/protocol.ts` (валидация: текст 0 < len ≤ 8000):

```
client → server:  { type:"user_text", id, text }
server → client:   { type:"ready", channelId, userId }
                   { type:"bot_text", id, text }
                   { type:"error", code, message }
```

`id` — клиентский (8 hex-байт), для дедупа.

## Адаптер и доставка

- `packages/channel-web/src/adapter.ts` — `WebChannelAdapter` (контракт
  `ChannelAdapter`): карта `externalUserId → WebSocket`, одна сессия на юзера
  (новое соединение вытесняет старое, close 1001), inbound через async-итератор.
- `apps/api/src/lib/web-dispatcher.ts` — `WebOutboundDispatcher` поллит
  `outbound_queue` по `kind='web'` (`SKIP LOCKED`) и шлёт кадры через адаптер.
  Живёт в apps/api (а не worker), т.к. WS pinned к процессу. `WebChannelRegistry`
  держит инстансы адаптеров.

Env-тюнинг: `WEB_DISPATCHER_POLL_MS` / `WEB_DISPATCHER_BATCH` / `WEB_WS_AUTH_SECRET`
/ `WEB_WIDGET_SCRIPT_URL` — см. [CONFIGURATION.md](CONFIGURATION.md).

## Кастомизация

Цвет (`data-color`), бренд (`data-brand`), auth (`data-auth`). Прочее
рендерится из `renderStyles(color)`; брендовые поля — в `channels.metadataJson`.
