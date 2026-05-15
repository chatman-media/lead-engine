# Userbot (MTProto)

Режим работы с личного аккаунта Telegram вместо бот-аккаунта. Используется gramjs (TDLib MTProto). Сессия хранится в PostgreSQL — рестарты не требуют повторного логина.

## Зачем

- Обычный Telegram-бот не может написать первым (только в ответ).
- Личный аккаунт выглядит как живой менеджер.
- Отвечает на `NewMessage` в личных чатах (DM) через тот же RAG-пайплайн.

## Предварительные требования

1. Получить `api_id` и `api_hash` на [my.telegram.org](https://my.telegram.org):
   - Логин → API development tools → Create application.
   - Скопировать `App api_id` (число) и `App api_hash` (строка).

2. Добавить в `.env`:

```bash
TELEGRAM_USERBOT=1
TELEGRAM_API_ID=12345678        # число
TELEGRAM_API_HASH=abc123def456  # строка
```

## Первый запуск: авторизация

```bash
bun scripts/userbot-auth.ts
```

Скрипт спросит:
1. Номер телефона (с кодом страны: `+7...`)
2. OTP-код из Telegram
3. Пароль двухфакторной аутентификации (если включён)

После успешного логина сессия сохраняется в `userbot_session` в базе данных. Скрипт выводит `Authenticated as: ИмяАккаунта (@username)`.

> **Важно:** Авторизацию нужно пройти один раз. После этого `bun run dev` / `bun run start` подхватывает сохранённую сессию автоматически.

## Как работает

```
Входящее личное сообщение (gramjs NewMessage event)
   │
   ▼
makeUserbotSender(msg.reply, tgUserId)
   │
   ▼
processInbound(db, telegramSender, ragDeps, update)
   │   — тот же пайплайн что у webhook
   ▼
msg.reply({ message: text })    ← ответ через gramjs closure
```

Ключевой паттерн — `msg.reply()` вместо `sendMessage(userId)`:

gramjs не может отправить сообщение по голому числовому `userId` без `access_hash` в кэше. При получении сообщения gramjs уже знает отправителя — `msg.reply()` отвечает напрямую без поиска entity.

Каждое входящее сообщение создаёт свой `TelegramClient`-совместимый объект с замыканием на конкретный `msg`:

```typescript
// src/telegram/userbot.ts
const telegramSender = makeUserbotSender(
  (text) => msg.reply({ message: text }),
  tgUserId,
);
await processInbound(db, telegramSender, ragDeps, userbotUpdate);
```

## Обработка непрочитанных при запуске

При старте сервера userbot автоматически обходит непрочитанные диалоги:

1. Получает список диалогов через `getDialogs()`.
2. Фильтрует только private чаты с `unreadCount > 0`.
3. Для каждого забирает последнее сообщение через `getMessages()`.
4. Запускает `processInbound()` — бот отвечает как будто получил сообщение сейчас.

Это решает сценарий: сервер был выключен, пришли сообщения → после рестарта бот ответит на всё.

## Параллельная работа с Bot API

Userbot и Bot API могут работать одновременно:
- Bot API webhook — отвечает пользователям, которые пишут боту (`@botname`).
- Userbot — отвечает пользователям, которые пишут напрямую на личный аккаунт.

Они независимы: разные `TELEGRAM_BOT_TOKEN` и `TELEGRAM_API_ID/HASH`, разные пользователи. Оба используют один и тот же RAG-пайплайн и одну БД.

## Конфигурация

| Переменная | Обязательная | Описание |
|---|---|---|
| `TELEGRAM_USERBOT` | да (`=1`) | Включить userbot |
| `TELEGRAM_API_ID` | да | api_id с my.telegram.org |
| `TELEGRAM_API_HASH` | да | api_hash с my.telegram.org |

Остальная конфигурация (LLM, KB, sales style) общая с Bot API режимом.

## Что делает userbot, что не делает

**Делает:**
- Отвечает на входящие DM через RAG (тот же пайплайн, тот же style).
- Обрабатывает непрочитанные при старте.
- Персистирует сессию в PostgreSQL (одна строка в `userbot_session`).

**Не делает:**
- Не пишет первым (нет метода initiate-conversation в текущей реализации).
- Не работает с группами (только DM).
- Не поддерживает callback_query / inline keyboards (только текстовые ответы).
- Не имеет отдельного admin UI — диалоги появляются в общем `/admin/chats` как обычные conversations.

## Безопасность

- `api_id` / `api_hash` — не секреты в строгом смысле (не аналог bot token), но не нужно их публиковать.
- Сессионная строка в `userbot_session` — эквивалент токена: кто угодно с этой строкой может работать от имени аккаунта. **Ограничьте доступ к базе данных PostgreSQL.**
- Если сессия скомпрометирована: завершить все сессии в Telegram Settings → Devices → Terminate All Other Sessions.

## Troubleshooting

### "TELEGRAM_USERBOT=1 but API_ID / API_HASH not set"

Проверьте `.env`: обе переменные должны быть заданы.

### "session_string is empty — skipping userbot startup"

Нужно пройти авторизацию:
```bash
bun scripts/userbot-auth.ts
```

### Бот не отвечает на личное сообщение

1. Убедитесь что в логах появляется `[userbot] incoming message from userId=...`.
2. Если строки нет — gramjs не получает события. Проверьте подключение.
3. Если строка есть, но бот молчит — проблема в RAG-пайплайне (LLM не настроен, KB пустая, `NO_CONTEXT`).

### "Could not find input entity"

Эта ошибка возникает если где-то используется `sendMessage(userId)` вместо `msg.reply()`. Вся отправка userbot-сообщений должна идти через `msg.reply()` closure — см. `makeUserbotSender()` в `src/telegram/userbot.ts`.

### Сессия устарела / невалидна

```bash
# Сбросить сессию в PostgreSQL и перелогиниться:
psql $DATABASE_URL -c "UPDATE userbot_session SET session_string = '' WHERE id = 1;"
bun scripts/userbot-auth.ts
```

## MTProto proxy (когда сервер блокирует Telegram)

Если egress-IP сервера не может достучаться до Telegram DC напрямую (госблок, фильтр провайдера), задайте `USERBOT_MTPROXY`. Принимаются три формата:

```bash
# Простейшая форма — host:port:secret
USERBOT_MTPROXY=proxy.example.com:443:dd1234567890abcdef1234567890abcd

# Или Telegram deep-link
USERBOT_MTPROXY=tg://proxy?server=proxy.example.com&port=443&secret=dd1234...

# Или t.me share-link
USERBOT_MTPROXY=https://t.me/proxy?server=proxy.example.com&port=443&secret=dd1234...
```

Парсер на старте валидирует формат — **малформед значение убивает userbot-подпроцесс c exit 1** (не падаем тихо к direct connection: на заблокированном сервере это маскировало бы реальную причину).

Где брать прокси:
- [github.com/SoliSpirit/mtproto](https://github.com/SoliSpirit/mtproto) — обновляется автоматически каждые 12 часов
- [mtpro.xyz/api](https://mtpro.xyz/api) — JSON-API с публичными прокси
- Или подними свой: [9seconds/mtg](https://github.com/9seconds/mtg)

**Trust note:** оператор прокси видит метаданные соединения (IP-адреса DC, тайминги). Содержимое сообщений зашифровано Telegram-сессией и недоступно прокси, но выбирайте источник осознанно.

**Ограничения текущей реализации** (одиночный прокси из env):
- При смерти прокси нужно вручную обновить переменную и перезапустить контейнер
- Авто-ротация (фолбэк на следующий прокси из списка) — отдельный feature, опциональный апгрейд в следующей итерации
