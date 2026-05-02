# tg-chatbot

Telegram-бот с RAG по базе знаний, анкетой по токену и админкой с ручным
перехватом диалога. Всё на чистом Bun без HTTP-фреймворка, БД — встроенный
`bun:sqlite` + расширение `sqlite-vec`. Поддерживаются OpenAI-совместимые
API и локальная Ollama (без расхода токенов).

Разрабатывается через TDD: на каждый юнит сначала падающий тест, потом
минимальная реализация. Текущее состояние: **220+ unit + 14 e2e зелёных.**

**Conversation export**: операторы могут скачать диалог (или пачку
с фильтрами по style/experiment/status/mode) как JSONL — `↓ JSONL`
кнопка на странице чата, или `GET /admin/api/conversations/export.jsonl`
для скрипт-доступа. Формат — OpenAI fine-tune compatible (`{"messages":[...]}`
один диалог на строку), готов для дообучения своей модели на лучших
переписках или передачи команде.

**Sales-style engine**: pluggable стили общения (флирт-рекрутер,
эмпатичный консультант, прямой PAS) с фреймворками продаж (AIDA/PAS/SPIN/
NEPQ/Belfort), хуками Чалдини, посменными промптами и few-shot примерами.
Управляется из админки (`/admin/styles`, `/admin/experiments`) — создаёшь
эксперимент с весами вариантов, кнопка `start` запускает A/B на новых
диалогах, на странице эксперимента видна per-style funnel-конверсия.

Активируется одним из:
- **Один стиль для всех** — `BOT_SALES_STYLE=flirty-belfort-v1` в `.env`.
- **A/B-тест из админки** — раздел "Experiments" → создать → start.

Подробности, схема БД, API и тесты — [docs/SALES_STYLES.md](docs/SALES_STYLES.md).

## Быстрый старт

```bash
bun install
cp .env.example .env        # отредактируйте под себя
bun run dev
```

Сервер слушает `PORT` (по умолчанию 3000). Health-чек:
[http://localhost:3000/health](http://localhost:3000/health).

## Выбор LLM-провайдера

`LLM_PROVIDER` управляет **чатом**, `EMBEDDING_PROVIDER` — **эмбеддингами**.
Они разделены потому что у OpenRouter нет endpoint'а для embeddings — даже
с `LLM_PROVIDER=openrouter` нужен второй провайдер для векторного поиска
(обычно локальная Ollama, она и без GPU быстро считает 100M-параметровые
embedder'ы).

### OpenAI / любой OpenAI-совместимый API

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIM=1536
```

### OpenRouter (Claude / GPT / Gemini одним ключом)

Когда локальная Ollama слишком медленная, а платить OpenAI напрямую не
хочется — OpenRouter даёт ~сотни моделей за один ключ. Особенно полезен
для Claude (лучше всех держит стиль и few-shot) и для A/B-тестирования
одной и той же персоны на разных backbone'ах.

```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_CHAT_MODEL=anthropic/claude-haiku-4.5

# OpenRouter не делает embeddings — embedder отдельный.
EMBEDDING_PROVIDER=ollama         # default когда chat=openrouter
OLLAMA_HOST=http://localhost:11434
OLLAMA_EMBEDDING_MODEL=bge-m3:latest
OLLAMA_EMBEDDING_DIM=1024

# Или если хотите всё через облако:
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=sk-...
```

Опционально — атрибуция в OpenRouter dashboard (видна в их UI с подсчётом
запросов/токенов на ваш проект):
```bash
OPENROUTER_SITE_URL=https://your-site.com
OPENROUTER_APP_NAME=tg-chatbot
```

Рекомендуемые модели для sales-бота:

| Модель | Цена ↓ | Русский | Стиль |
|---|---|---|---|
| `anthropic/claude-haiku-4.5` | $$ | excellent | холодный/тёплый держит ровно |
| `anthropic/claude-sonnet-4.6` | $$$$ | excellent | лучшее follow для few-shot |
| `openai/gpt-4o-mini` | $ | good | быстро, но стилистически блёкло |
| `google/gemini-2.5-flash` | $ | good | дешевле всех frontier-class |
| `qwen/qwen3-8b` | $ | good | то же что у тебя локально, но в облаке |

### Локальная Ollama (без токенов)

```bash
LLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen3:latest      # послушный к system-prompt, без «переспрашиваний»
OLLAMA_EMBEDDING_MODEL=bge-m3:latest  # мультиязычный (ru/zh/ko), 1024-dim
OLLAMA_EMBEDDING_DIM=1024
RAG_MAX_DISTANCE=1.00                # bge-m3 даёт ~0.75–0.95 для on-topic, 1.05+ для шума
RAG_TOP_K=5
```

Перед стартом:

```bash
ollama serve                       # или Ollama Desktop
ollama pull qwen3                  # 8B, q4_K_M, ~5 GB VRAM, 30K context
ollama pull bge-m3                 # 567M, FP16, мультиязычный embedder
```

Замечания по чат-моделям:

- `qwen3` хорошо слушается system-prompt, по-русски естественен и
  поддерживает «выключенный thinking»: бот шлёт `think:false` и подмешивает
  `/no_think` в system-сообщение, иначе модель тратит токены на CoT-блок.
- `llama3.1` / `llama3.2` — быстрее, но хуже выдерживают строгие негативные
  правила («не переспрашивай», «не упоминай оператора»).
- Модели семейства `gemma3` (включая фай-тюны вроде `rnj-1`) **не**
  рекомендуются как чат-модель: они склонны переспрашивать «что именно
  интересует?» вместо ответа.

Размерность векторного индекса синхронизируется автоматически: если
`OLLAMA_EMBEDDING_DIM` отличается от текущей, таблица `kb_vec` пересоздаётся
при старте (с предупреждением — KB нужно переиндексировать).

| Эмбеддинг-модель | dim |
|---|---|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `bge-m3` | 1024 |

## CLI

```bash
bun run build:ui                               # собрать React SPA (admin-ui/dist/)
bun run dev:ui                                 # Vite dev-server с HMR на :5173 (proxy → :3000)
bun scripts/extract-tg.ts <result.json> <out>  # извлечь корпус из Telegram-экспорта
bun scripts/transcribe.ts <result.json> [out]  # расшифровать голосовые через Whisper
bun scripts/ingest.ts ./docs                   # индексация .md/.txt в KB
bun scripts/create-admin.ts <email> <password> # создать аккаунт админа
bun scripts/set-webhook.ts set <publicUrl>     # привязать webhook к Telegram
bun scripts/set-webhook.ts info                # проверить статус
bun scripts/set-webhook.ts delete              # отвязать
```

## База знаний: пайплайн данных

Бот отвечает на вопросы по корпусу `.md`/`.txt`-документов из вашего KB.
Полный путь от сырых данных до проиндексированной базы — пять этапов:

```
Telegram-экспорт (result.json + медиа)
        │
        ▼  scripts/extract-tg.ts
kb/extracted/  posts/  dialogs/  voice/INDEX.md
        │
        ▼  scripts/transcribe.ts          (опционально: голосовые → текст)
kb/extracted/  + транскрипты, встроенные в диалоги
        │
        ▼  курация (вручную)
kb/curated/   тематические .md без дублей и шума
        │
        ▼  scripts/ingest.ts
SQLite + sqlite-vec   (kb_documents / kb_chunks / kb_vec)
```

### 1. Экспорт из Telegram

В Telegram Desktop: `Settings → Advanced → Export Telegram data`. В формате
**JSON**, выбрать только нужные чаты (или всё), включить медиа: голосовые,
видео, стикеры опционально. Получится папка с `result.json` (главный
индекс) и подпапками `chats/chat_NNN/voice_messages/*.ogg`. Положить всё
в `kb/`:

```
kb/
  result.json
  chats/
    chat_001/voice_messages/...
    chat_002/voice_messages/...
    ...
```

### 2. Экстракция корпуса (`extract-tg.ts`)

Скрипт парсит `result.json` и формирует первичный корпус:

```bash
bun scripts/extract-tg.ts kb/result.json kb/extracted
# опционально другой отправитель:
# bun scripts/extract-tg.ts kb/result.json kb/extracted --agent user1234567890
```

Что он делает:

- Идентифицирует **сообщения агента** по `from_id` (по умолчанию
  `user8201160309`). Через флаг `--agent` можно указать другой ID.
- Из всех длинных (≥250 символов) сообщений агента собирает **уникальные
  посты с дедупликацией по содержимому** — один и тот же шаблон
  вакансии, разосланный в 20 чатов, сохранится один раз с пометкой
  `<!-- occurrences: 20 -->`. Кладёт в `kb/extracted/posts/`.
- Из чатов с реальной активностью (≥2 сообщения агента и ≥2 совпадения
  по словарю «работа/вакансия/агентство/...») собирает **диалоги в
  формате Q&A**, склеивает соседние реплики одной стороны, обрезает
  «висящие» вопросы без ответа. Кладёт в `kb/extracted/dialogs/`.
- Все **голосовые от агента** индексирует в `kb/extracted/voice/INDEX.md`
  с путём к файлу, длительностью и привязкой к чату — для последующей
  расшифровки.
- Пишет `kb/extracted/README.md` со статистикой: сколько чатов
  обработано, сколько уникальных постов, диалогов, голосовых.

Скрипт идемпотентен — можно перезапускать после нового экспорта.

### 3. Транскрипция голосовых (`transcribe.ts`) — опционально

Голосовые от агента часто содержат то, что текстом не написано
(детали условий, ответы на нестандартные вопросы). Скрипт идёт по
`result.json`, находит `voice_message`-сообщения, гонит каждый `.ogg`
через Whisper-совместимый endpoint и кэширует результат:

```
kb/extracted/voice/transcripts/<chat_dir>__<file_stem>.txt
```

Кэш — один файл на одну запись, скрипт **резюмируемый**: повторный
запуск пропустит уже расшифрованные. Падение в середине не страшно.

```bash
# по умолчанию — только голосовые от агента (32 файла, ~7 минут)
bun scripts/transcribe.ts kb/result.json kb/extracted

# вместе с голосовыми кандидатов (всего 82 файла, ~30 минут)
bun scripts/transcribe.ts kb/result.json kb/extracted --all

# показать что будет расшифровано, без вызова API
bun scripts/transcribe.ts kb/result.json kb/extracted --dry-run
```

Конфигурация через `.env` (или переменные среды):

```
WHISPER_BASE_URL=https://api.openai.com/v1   # или ваш локальный whisper-сервер
WHISPER_API_KEY=sk-...                       # либо OPENAI_API_KEY как fallback
WHISPER_MODEL=whisper-1
WHISPER_LANGUAGE=ru
```

Для **полностью локального** варианта (без облачных API) можно поднять
`faster-whisper-server` (или любой другой OpenAI-совместимый прокси к
whisper) и указать `WHISPER_BASE_URL=http://localhost:8000/v1`.

После транскрипции **повторно запустите `extract-tg.ts`** — он подхватит
кэшированные транскрипты и встроит их в `dialogs/*.md` в правильной
хронологии с пометкой `[голосовое, Xс] <текст>`. Длинные монологи
агента (≥250 символов) дополнительно попадут в `posts/` как отдельные
дедуплицированные документы.

### 4. Курация (вручную)

`kb/extracted/` — это **сырьё**, а не продакшн-база. На этом этапе
человек открывает выгрузку и принимает решения, которые машина
принять не может:

- В `posts/` — удалить мусор (черновики, переводы, дубли близкие, но
  не идентичные), объединить родственные посты в тематические файлы
  (`china-ktv.md`, `korea-karaoke.md`, `application-form.md`).
- В `dialogs/` — оставить только содержательные Q&A, выбросить чаты,
  где кандидат отвалился после первой реплики. Хорошие пары
  «вопрос → ответ» вынести в общий `faq.md`.
- Привести стиль к единому: убрать имена, личное, эмодзи-шум, если
  мешают. В KB должно быть то, что бот может говорить любому клиенту.

Результат складывать в `kb/curated/` — это и есть финальная база
знаний, готовая к индексации.

### 5. Индексация в векторную БД (`ingest.ts`)

```bash
bun scripts/ingest.ts kb/curated
```

Скрипт:

1. Читает все `.md`/`.txt` рекурсивно (другие расширения пропускает).
2. Считает SHA-256 содержимого; неизменённые файлы **пропускает**
   (идемпотентность — можно запускать после каждой правки).
3. Изменённые — режет на чанки ≈1500 символов с overlap 150 по
   границам абзацев, батчем гонит через эмбеддер, пишет в
   `kb_chunks` + `kb_vec` одной транзакцией.
4. Старые чанки документа удаляются перед переиндексацией.

Бот видит обновлённую базу сразу — рестарт сервера не нужен,
вектора лежат в той же `data/bot.db`.

### Как ответ доходит до пользователя

При входящем сообщении в Telegram: webhook эмбеддит вопрос
тем же провайдером, что и индексация → `kb_vec` возвращает top-K
ближайших чанков (L2-distance) → они склеиваются в системный
промпт `«отвечай только по CONTEXT, иначе верни __NO_CONTEXT__»` →
LLM генерирует ответ → если получили `__NO_CONTEXT__`, диалог
уходит в `mode=queued` и в чат отправляется короткая «человеческая»
заминка (см. ниже про персону), а админ перехватывает в админке.
Иначе ответ уходит в чат, а `used_chunk_ids` сохраняются в
`meta_json` сообщения для аудита.

### Персона бота и фолбэк-фразы

Бот говорит от лица живого менеджера — имя, роль и компания
задаются в `.env`:

```bash
BOT_PERSONA_NAME=Алина
BOT_PERSONA_ROLE=human       # human → притворяется человеком; assistant → честный AI
BOT_PERSONA_COMPANY=INFINITY AGENCY
```

В режиме `human` системный промпт явно запрещает упоминать слова
«бот», «ИИ», «ассистент», «оператор», «коллега», «свяжитесь с
менеджером» — модель должна вести диалог сама. Когда в KB не
нашлось ответа, бот не сочиняет: возвращает маркер
`__NO_CONTEXT__`, а webhook отправляет короткую заминку и
ставит чат в очередь админу. Тексты заминок живут как константы
в `src/telegram/webhook.ts` (`ESCALATION_REPLY` /
`QUEUED_REPLY` / `PLACEHOLDER_REPLY`) — все по-русски, в стиле
«секунду, уточню и напишу», без слова «оператор».

Чувствительность к «нет ответа» крутится через `RAG_MAX_DISTANCE`
в `.env` (sqlite-vec L2): чем меньше — тем строже отсекаются
слабые попадания, тем чаще диалог уйдёт в очередь вместо
галлюцинации. Пустое значение = без порога (отдаём всё, что
вернул top-K).

Подбор порога зависит от эмбеддера и **корпуса**:

- `bge-m3` (рекомендуется для ru/zh/ko корпусов): on-topic ~0.75–0.95,
  off-topic ≥1.05 → разумный порог `RAG_MAX_DISTANCE=1.00`.
- `nomic-embed-text` (английский, слабее на CJK): on-topic ~0.55–0.65,
  off-topic 0.62+ — порог здесь почти не разделяет темы, поэтому RAG
  может «галлюцинировать через соседнюю страну». Для нашего сценария
  (Корея/Китай) недостаточно избирателен.

Чтобы перейти на другой эмбеддер: поменять `OLLAMA_EMBEDDING_MODEL` +
`OLLAMA_EMBEDDING_DIM`, очистить `kb_chunks` / `kb_documents` и
прогнать `bun scripts/ingest.ts <корпус>` — таблица `kb_vec` пересоздаётся
автоматически при изменении `dim`.

### Скорость / латентность ответа

`OllamaChatClient` явно ограничивает `num_ctx=4096` и `num_predict=256`
и шлёт `keep_alive: "30m"`. Это:

- держит KV-cache `qwen3` в районе 5–6 GB VRAM (а не 11 GB при
  дефолтных 40K context) — модель помещается и быстрее обрабатывает
  prompt;
- кладёт верхнюю границу на длину ответа (бот не выдаёт «эссе»);
- не даёт Ollama выгружать модель между сообщениями, чтобы не было
  10-секундных холодных стартов.

Ускорить дальше можно либо переходом на меньшую чат-модель
(`llama3.2:3b` ≈ в 2–3× быстрее, ценой более слабого следования
системным правилам), либо на облачную (`*:cloud` в Ollama).

## Тесты

- Бэкенд (юниты): `bun run test`
- E2E (Playwright): `bun run test:e2e:install` (один раз) и `bun run test:e2e`

Playwright поднимает сервер автоматически на отдельном порту (`E2E_PORT`,
по умолчанию 3100) с тестовой БД `data/test.db` и `TEST_HOOKS=1`, чтобы тесты
могли сидать данные через `/__test/*` (эти роуты доступны только при этом
флаге и не должны включаться в проде).

## Архитектура

```
Telegram → /telegram/<secret> ─┬─► whitelist (UsersRepo)
                                ├─► message persisted (MessagesRepo)
                                ├─► escalation triggers? ─► mode=queued
                                └─► RAG: embed → kb.search → LLM
                                    └─► NO_CONTEXT? ─► mode=queued
```

- `src/router.ts` — мини-роутер поверх `Bun.serve`.
- `src/server.ts` — `createServer()`: объединяет router + WebSocket upgrade.
- `src/db/` — `bun:sqlite` + `sqlite-vec`, миграции, репозитории.
- `src/rag/` — чанкинг, эмбеддинги (OpenAI/Ollama), retrieval, ответы.
- `src/telegram/` — клиент Bot API, webhook, эскалация.
- `src/questionnaire/` — токены и форма `/q/:token`.
- `src/admin/auth.ts` — логин/логаут/сессии (`Bun.password` argon2id, HttpOnly cookie).
- `src/admin/api.ts` — REST: пользователи, диалоги, take/release.
- `src/admin/bus.ts` — `AdminBus`: pub/sub для WS-клиентов.

### Admin API (все за исключением `login` требуют авторизацию через cookie)

| Метод | Путь | Описание |
|---|---|---|
| `POST` | `/admin/api/login` | Вход, возвращает `Set-Cookie` |
| `POST` | `/admin/api/logout` | Выход, сбрасывает cookie |
| `GET` | `/admin/api/me` | Текущий администратор |
| `GET` | `/admin/api/users` | Список пользователей |
| `GET` | `/admin/api/conversations` | Список диалогов (queued первые) |
| `GET` | `/admin/api/conversations/:id` | Диалог + сообщения |
| `POST` | `/admin/api/conversations/:id/take` | Переключить в `human` |
| `POST` | `/admin/api/conversations/:id/release` | Вернуть в `ai` |
| `POST` | `/admin/api/conversations/:id/reply` | Отправить ответ из админки в TG |
| `DELETE` | `/admin/api/conversations/:id` | Снести диалог + историю (статус `mode` сбросится при следующем сообщении) |
| `WS` | `/admin/api/ws` | Realtime-события (`message:new`, `conversation:updated`) |

## Прогресс

| # | Задача | Статус |
|---|---|---|
| 1 | `bootstrap` — Bun.serve, мини-роутер, `/health`, Playwright smoke | ✅ |
| 2 | `db-layer` — `bun:sqlite` + `sqlite-vec`, миграции, репозитории | ✅ |
| 3 | `tg-client` — клиент Bot API + `setWebhook` CLI | ✅ |
| 4 | `webhook` — `/telegram/<secret>` с whitelist и плейсхолдером | ✅ |
| 5 | `kb-ingest` — CLI: txt/md → чанки → эмбеддинги | ✅ |
| 6 | `rag` — retrieval top-k + LLM + ответ в TG | ✅ |
| 7 | `questionnaire` — токен + GET/POST `/q/:token` + Playwright | ✅ |
| 8 | `ollama` — нативный провайдер + динамический `kb_vec` | ✅ |
| 9 | `escalation` — триггеры (ключевые слова + `NO_CONTEXT`) → `queued` | ✅ |
| 10 | `admin-auth` — `Bun.password` + сессии + middleware `/admin/*` | ✅ |
| 11 | `admin-api-ws` — REST + WebSocket-бродкаст для админки | ✅ |
| 12 | `admin-ui` — React + Vite: Login / Users / Chats / Chat | ✅ |
| 13 | `admin-reply` — ответ из админки → TG + WS + возврат `mode=ai` | ✅ |
| 14 | `smoke` — финальный happy-path E2E + чеклист релиза | ✅ |
