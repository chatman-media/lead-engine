# RAG layers

Четыре опциональные надстройки над базовым `RAG = embed → kb.search → LLM` пайплайном. Каждая решает одну конкретную проблему «vanilla RAG», все включаются независимыми env-флагами, по умолчанию выключены.

## Зачем это нужно

«Vanilla RAG» (один векторный поиск + системный промпт + LLM) хорош для одиночных well-bounded запросов, но в продолжительных диалогах разваливается:

| Проблема | Что добавили |
|----------|--------------|
| Точные совпадения (числа, имена городов) embeddings ранжирует мимо | **Hybrid retrieval** (BM25 + vector + RRF) |
| Бот переспрашивает то, что уже знает из прошлой сессии | **Cross-session memory** |
| «А там?» / «и сколько?» — vector search на одном слове промахивается | **Query rewriting** |
| LLM выдумывает цифры/города, которых нет в KB | **Reflection** |

Все слои вместе превращают «AI assistant» tier (по таксономии arxiv:2601.12560) в нижний слой «Agentic AI» — без monolithic-→-multi-agent рефакторинга и при том же количестве кода.

---

## 1. Hybrid retrieval — `RAG_HYBRID_SEARCH=true`

### Проблема

Embedding-поиск отлично работает для семантической близости (`"сколько платят"` ↔ `"оплата 1500 в день"`), но плохо ранжирует **точные совпадения**: запрос `"виза 30 дней"` может найти "сроки контракта" (семантически близко) выше, чем чанк, где буквально написано "виза оформляется на 30 дней".

### Решение

Параллельно с векторным поиском запускается **BM25** (через SQLite FTS5) — классический keyword-матчинг. Результаты двух индексов объединяются через **Reciprocal Rank Fusion** (стандарт в production-search):

```
score(chunk) = Σ 1 / (60 + rank_i)   для каждого индекса i, где chunk встретился
```

RRF использует **только ранги**, не сырые скоры — это ключевое: BM25 score (`-9.2e-7`) и L2 distance (`0.83`) живут в несовместимых шкалах, попытка взвешивать их (`0.7*vec + 0.3*bm25`) требует пересчёта при смене embedder.

### Архитектура

```
question → embed(question) ─┬─► kb.search(vec, k=10)        ─┐
                            │                                ├─► RRF → top-k
question (как текст) ───────┴─► kb.searchBm25(query, k=10)  ─┘
```

- Файлы: [src/db/repos/kb.ts](src/db/repos/kb.ts) (`searchBm25`, `hybridSearch`, `reciprocalRankFusion`, `sanitizeFtsQuery`)
- Миграция: [migrations/005_kb_fts.sql](migrations/005_kb_fts.sql) — FTS5 virtual table + 3 sync-триггера
- Токенайзер: `unicode61 remove_diacritics 2` — корректно работает с кириллицей и латиницей одновременно

### Цена

- **0 LLM-вызовов** — самый дешёвый из всех слоёв
- +1 SQL запрос к FTS5 индексу (sub-ms на типичных KB до 100k чанков)
- Один раз ингест миграции 005 — backfill существующих чанков, потом FTS держится в синке через триггеры

### Известное ограничение

FTS5 prefix-matching forward-only: запрос `"виз*"` найдёт `виза`/`визу`/`визой`, но `"визой*"` НЕ найдёт `виза`. Для полной русской морфологии нужен snowball-стеммер. **Векторная сторона гибрида закрывает gap end-to-end** — embeddings ловят словоформы независимо от BM25, поэтому в реальности это редко вылезает.

### Что включить с этим флагом

`RAG_MAX_DISTANCE` игнорируется когда `hybridSearch=true` (fused rank в другой шкале). Если у тебя сейчас выставлен порог — после включения hybrid будут возвращаться все top-k, отфильтруй через NO_CONTEXT-логику в LLM-промпте (она уже есть).

---

## 2. Cross-session memory — `RAG_USER_MEMORY=true`

### Проблема

Кандидат пишет "я Аня из Москвы, 25 лет" → диалог удалили (или прошёл месяц, история обрезалась) → следующий заход бот переспрашивает "как тебя зовут? откуда?". Это убивает эффект "живого менеджера" быстрее, чем любая стилевая ошибка.

### Решение

После каждого ответа бот извлекает факты о кандидате через отдельный LLM-вызов и кладёт в `users.profile_json.memory.facts`. На следующем turn'е факты подмешиваются в системный промпт:

```
ЗНАЕМ О КАНДИДАТЕ (из прошлых разговоров — НЕ переспрашивай):
- name: Аня
- city: Москва
- age: 25
- intent: работа в Дубае
```

Память **переживает удаление conversation** — она привязана к `users.id`, не к `conversation.id`. Это и нужно: оператор сбросил диалог чтобы начать заново → персональные данные сохранились.

### Архитектура

```
[user message inbound]
       │
       ▼
read users.getMemory(userId)  ──► inject into system prompt
       │
       ▼
RAG → reply → send to TG
       │
       ▼
[after reply, fire-and-forget]
extractUserFacts(messages since lastExtractedFromMsgId, chat)
       │
       ▼
users.mergeMemoryFacts(userId, newFacts, lastMsgId)
```

- Извлечение: [src/rag/extract-user-facts.ts](src/rag/extract-user-facts.ts) — LLM-вызов с строгой JSON-схемой, fail-soft на parse errors
- Хранилище: `users.profile_json.memory` — без новых таблиц/миграций
- Курсор: `lastExtractedFromMsgId` — экстрактор не перечитывает уже обработанные сообщения
- Инъекция: `renderUserFactsBlock` в [src/rag/answer.ts](src/rag/answer.ts) — переиспользуется и legacy-persona путём, и sales-style композером

### Цена

- **+1 LLM-вызов на turn** — но **AFTER reply, fire-and-forget**: не блокирует ответ кандидату
- Извлечение работает на дельте (только новые сообщения), не на полной истории — постоянная стоимость, не растёт с длиной чата

### Операторский UI

`Chat` страница в админке имеет раскрывающуюся **MEMORY** панель ([admin-ui/src/components/MemoryPane.tsx](admin-ui/src/components/MemoryPane.tsx)):
- видит все извлечённые факты
- может править значения inline
- может удалить ошибочный ключ
- может добавить факт вручную (например, статус кандидата, обещание перезвонить)
- кнопка SAVE → `PATCH /admin/api/users/:id/memory` → факты **заменяют** хранящиеся (не мержатся, потому что оператор авторитетнее экстрактора)
- следующий turn бота уже видит правки

### Что важно

Этот слой работает в паре с [`Persona.facts`](../src/rag/answer.ts) (фактами **бота**, не кандидата). Не путать:
- `Persona.facts` — что бот говорит о СЕБЕ (`{ city: "Шаохинг", age: "26" }`) — задаётся через `BOT_PERSONA_FACTS` env
- `users.profile_json.memory.facts` — что бот знает о КАНДИДАТЕ (`{ name: "Аня", city: "Москва" }`) — извлекается экстрактором + правится оператором

---

## 3. Query rewriting — `RAG_QUERY_REWRITE=true`

### Проблема

Кандидат спросил `"сколько платят в Дубае?"`, потом follow-up: `"а в Стамбуле?"`. Embedding короткой фразы `"а в Стамбуле?"` не несёт контекста "оплата" — vector search вернёт случайные чанки про Стамбул, а не про условия работы там.

### Решение

Перед vector search запрос переформулируется LLM в **самостоятельный поисковый запрос** с использованием recent history:

```
история:
user: сколько платят в Дубае?
assistant: 1500 в день, контракт 30 дней
вопрос: а в Стамбуле?
ответ: какие условия и оплата в Стамбуле
```

Используется ТОЛЬКО для retrieval — оригинал кандидата идёт в промпт LLM, в conversation history, и в логах. Никаких изменений в "видимой" переписке.

### Архитектура

```
question → questionNeedsRewrite(q, history)?
            │
            ├── false (полный самостоятельный вопрос) → используем как есть
            │
            └── true (короткий follow-up / pronoun / "а"-conjunction)
                    └── LLM rewrite → use rewritten for embed/BM25
```

- Файл: [src/rag/rewrite-query.ts](src/rag/rewrite-query.ts)
- **Эвристика-гейт** `questionNeedsRewrite` пропускает случаи, когда rewrite не нужен (длинный вопрос, нет deictic-маркеров) — экономит ~80% LLM-вызовов
- Cyrillic-aware regex (через Unicode property lookahead, не `\b`) — иначе на русских deictic-словах не срабатывает

### Цена

- +1 LLM-вызов **только на flagged turns** — обычно 20–30% диалога
- Можно использовать дешёвую быструю модель (`gpt-4o-mini`/`haiku`/`qwen3:8b`) — задача синтаксическая, не семантическая

### Что важно

Эвристика консервативна — лучше пропустить rewrite, чем вызвать его на полном вопросе и получить неудачную перезапись. Если в production видишь, что follow-up'ы не ловятся — расширь deictic-список в `rewrite-query.ts`.

---

## 4. Reflection — `RAG_REFLECT=true`

### Проблема

LLM иногда выдумывает: цифру (`"5000 евро в день"` вместо `1500 юаней` из KB), страну (`"в Корее платят 2000"` когда в KB только Китай), срок (`"контракт на полгода"` когда везде написано 30 дней). Системный промпт говорит "не выдумывай", но это рекомендация, не гарантия.

### Решение

Перед отправкой в Telegram ответ проверяется отдельным LLM-вызовом: «есть ли в этом ответе конкретные факты, которых нет в CONTEXT?». Verifier возвращает `{grounded: true}` или `{grounded: false, reason: "..."}`. Если ungrounded — ответ заменяется на `NO_CONTEXT_MARKER` → бот **молчит** (mode остаётся `ai`).

### Архитектура

```
RAG → answer → if (config.reflect) → verifyAnswer({question, answer, context})
                                       │
                                       ├── grounded:true → send to TG
                                       └── grounded:false → log reason, drop reply (silent)
```

- Файл: [src/rag/reflect.ts](src/rag/reflect.ts)
- **Fail-open** на ошибках verifier'а: лучше пропустить редкую галлюцинацию, чем молча дропать рабочие ответы из-за слетевшего парсинга JSON
- Skip-условия: пустой ответ, пустой context (smalltalk / persona-fact bypass) — verifier не запускается

### Цена

- +1 LLM-вызов на turn
- **Только на grounded turns** — smalltalk и persona-факты возвращаются без context'а и verifier пропускается
- Используй ту же модель что и для основного ответа, или дешевле — задача классификационная

### Что ожидать

После включения количество silent-turns (NO_CONTEXT) подрастёт. Это **feature, не bug** — это и есть то, что verifier ловит. Если рост слишком резкий (>20% turns), значит:
- system prompt не достаточно строг к "уточню у руководства" (модель пишет "позже расскажу" — verifier правильно режет)
- KB слишком разреженная — добавь чанков по проблемным темам

В админке такие случаи видны как "пользователь написал → бот не ответил" — оператору пинг ➜ можно перехватить через `Take over`.

---

## Все вместе

```
inbound message
   │
   ▼
[1] read user memory → inject candidate facts into system prompt
   │
   ▼
[2] questionNeedsRewrite? → rewriteQuery → use rewritten for retrieval
   │
   ▼
[3] hybridSearch (BM25 + vector + RRF)
   │
   ▼
LLM with system prompt (persona + persona facts + user facts + KB context)
   │
   ▼
[4] reflect: is the answer grounded?
   │   ├── yes → send to TG
   │   └── no → drop, stay silent
   │
   ▼
[after reply, fire-and-forget]
extract new candidate facts → merge into user memory
```

## Рекомендованный порядок включения

1. **Сначала** `RAG_HYBRID_SEARCH=true` — нет LLM-цены, нет риска извлечения, чистый upgrade retrieval.
2. **Потом** `RAG_USER_MEMORY=true` — посмотри неделю на extraction quality в админке, поправь явные ошибки.
3. **Потом** `RAG_QUERY_REWRITE=true` — особенно если у тебя длинные follow-up диалоги.
4. **В последнюю очередь** `RAG_REFLECT=true` — это самый дорогой слой (по латентности — удваивает время до ответа).

Если включаешь все четыре сразу: суммарная стоимость ≈ +2.5 LLM-вызова на средний turn (rewrite — на 25% turns, reflect — на 80% grounded turns, memory extraction — на каждом turn но after-reply, не на критическом пути).

## Telemetry

Каждый вызов `answerWithRag` возвращает `AnswerResult.telemetry` ([src/rag/answer.ts](../src/rag/answer.ts)) — диагностический блок, который webhook кладёт в `messages.meta_json.telemetry` для каждого ответа бота.

```ts
{
  path: "smalltalk" | "persona_fact" | "no_context" | "ungrounded" | "ok",
  total_ms: 1340,
  retrieval_ms: 80,
  generation_ms: 1200,
  top_distances: [0.83, 0.91, 1.04],
  hybrid: true,                                    // когда RAG_HYBRID_SEARCH=true
  original_query: "а в стамбуле?",                 // только когда rewrite сработал
  rewritten_query: "какие условия в Стамбуле",
  reflect: { grounded: false, reason: "..." }      // когда RAG_REFLECT=true
}
```

В админке: на странице чата есть кнопка **DEBUG**. Включение → под каждым ответом бота появляется `TelemetryStrip` — одна строка с диагностикой (цвет по `path`: зелёный = ok, жёлтый = no_context, красный = ungrounded). Нужен чтобы локализовать regressions: «качество просело — это retrieval, generation или reflect?». Без перезапуска LLM, по уже сохранённым данным.

## Тесты

| Слой | Файл с тестами | Покрытие |
|------|----------------|----------|
| Hybrid | [tests/unit/hybrid-search.test.ts](../tests/unit/hybrid-search.test.ts) | sanitize, BM25, RRF, fallback пути, sync triggers |
| Memory | [tests/unit/extract-user-facts.test.ts](../tests/unit/extract-user-facts.test.ts) + [tests/unit/db.test.ts](../tests/unit/db.test.ts) | extraction, JSON parse, repo CRUD, profile preserve |
| Memory API | [tests/unit/admin-api.test.ts](../tests/unit/admin-api.test.ts) | `GET /conversations/:id` includes memory; `PATCH /users/:id/memory` |
| Query rewrite | [tests/unit/rewrite-query.test.ts](../tests/unit/rewrite-query.test.ts) | heuristic, sanitize, fallback на ошибки |
| Reflect | [tests/unit/reflect.test.ts](../tests/unit/reflect.test.ts) | parse, fail-open, skip empty answer/context |
| Telemetry | [tests/unit/answer.test.ts](../tests/unit/answer.test.ts) | path tags, latencies, top_distances, hybrid marker, rewrite passthrough |
