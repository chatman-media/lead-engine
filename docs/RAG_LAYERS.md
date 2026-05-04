# RAG layers

Шесть опциональных надстроек над базовым `RAG = embed → kb.search → LLM` пайплайном. Каждая решает одну конкретную проблему «vanilla RAG», все включаются независимыми env-флагами, по умолчанию выключены.

## Зачем это нужно

«Vanilla RAG» (один векторный поиск + системный промпт + LLM) хорош для одиночных well-bounded запросов, но в продолжительных диалогах разваливается:

| Проблема | Что добавили |
|----------|--------------|
| Точные совпадения (числа, имена городов) embeddings ранжирует мимо | **Hybrid retrieval** (BM25 + vector + RRF) |
| Бот переспрашивает то, что уже знает из прошлой сессии | **Cross-session memory** |
| «А там?» / «и сколько?» — vector search на одном слове промахивается | **Query rewriting** |
| LLM выдумывает цифры/города, которых нет в KB | **Reflection** |
| В длинных диалогах теряется контекст из turn'ов 1–N (recent window = 12) | **Conversation summarization** |
| KB растёт, embeddings смешивают темы (visa/payment/locations/...) — precision падает | **Topic-routed retrieval** |

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

---

## 5. Conversation summarization — `RAG_CONVERSATION_SUMMARY=true`

### Проблема

`recentForContext(conv.id, 12)` — фиксированное окно. На 30+ turn диалогах turns 1..N-12 уже не попадают в системный промпт. User-memory покрывает **факты** про кандидата ("Аня, 25, Москва"), но не **нюансы**: "обещал прислать договор завтра", "кандидат сомневался по визе", "уже отправили ссылку на анкету".

### Решение

Старая часть переписки сжимается LLM-вызовом в один абзац (3-6 предложений в третьем лице). Хранится в `conversations.summary_json` как `{ summary, summarizedThroughMsgId, updatedAt }`. Инжектится в систему как `ИЗ РАННЕЙ ПЕРЕПИСКИ:` блок.

Refresh **ленивый**: после каждой реплики проверяем gap между `summarizedThroughMsgId` и текущим последним «summary-eligible» message id. Если gap ≥ 8 — рефрешим. Иначе используем то что есть.

При refresh передаём предыдущее summary + новые сообщения → LLM **обновляет** existing summary, а не пересчитывает всё с нуля. Это держит cost и latency константными независимо от длины чата.

### Архитектура

```
processInbound → reply → fire-and-forget runConversationSummaryRefresh
                            │
                            ├── total messages < 30? → skip
                            │
                            ├── gap < 8 messages from lastSummarizedId? → skip
                            │
                            └── summarizeConversation({
                                  messagesToSummarize: новый slice,
                                  previousSummary: stored.summary,
                                })
                                → conversations.setSummary(...)
```

- Файлы: [src/rag/summarize-conversation.ts](src/rag/summarize-conversation.ts), [src/db/repos/conversations.ts](src/db/repos/conversations.ts) (`getSummary` / `setSummary`)
- Миграция: [migrations/006_conversation_summary.sql](migrations/006_conversation_summary.sql) — `ALTER TABLE conversations ADD COLUMN summary_json TEXT`
- Триггер refresh'а: [`runConversationSummaryRefresh`](src/telegram/webhook.ts) — те же thresholds (`SUMMARY_START_THRESHOLD=30`, `SUMMARY_RECENT_WINDOW=12`, `SUMMARY_STALENESS=8`)

### Цена

- **0 LLM-вызовов на короткие чаты** (порог в 30 turn'ов)
- **+1 LLM-вызов раз в 8 turn'ов** на длинных — благодаря refine-вместо-regenerate, размер каждого вызова не растёт с длиной чата
- Fire-and-forget — не блокирует ответ кандидату

### Что важно

- Summary — это **дополнение**, не замена `recentForContext`. Последние 12 turn'ов всё равно попадают в промпт сырыми. Summary даёт continuity для всего что старше.
- Memory facts работают параллельно: facts хранят кто кандидат (имя/город/возраст), summary хранит что уже обсуждалось (обещания/сомнения/explained-vs-open).
- Пороги (30 / 12 / 8) — константы в `webhook.ts`, не env-переменные. Это quality knobs не deployment knobs, и они должны быть скоординированы.

---

---

## 6. Topic-routed retrieval — `RAG_TOPIC_ROUTING=true`

### Проблема

Когда KB растёт за 30+ документов, embeddings всё хуже разделяют темы. На запрос "виза 30 дней" может всплыть chunk про "сроки контракта в Дубае" — семантически близкий, но не то что спросили. На "сколько платят в Стамбуле" приходит "общая информация про работу" из несвязанной заметки. Эту проблему называют "embedding crowding": в едином пространстве близких по смыслу документов precision падает быстрее чем растёт recall.

### Решение

Тегируем документы темой при ingest, классифицируем вопрос регекспом, фильтруем поиск по тегу. **Никаких LLM-вызовов** — классификатор полностью deterministic.

```
question → classifyTopic (regex) ─┐
                                   │
                                   ├── matched 1 topic? → kb.search(vec, k, topic=visa)
                                   │                       │
                                   │                       └── 0 hits? → fallback: kb.search(vec, k) (global)
                                   │
                                   └── 0 or 2+ matches? → kb.search(vec, k) (global, no filter)
```

Никогда не уменьшает recall — fallback на global search срабатывает когда:
- классификатор не уверен (нет/несколько матчей)
- topic-фильтр вернул 0 хитов

NULL-topic документы всегда проходят фильтр — back-compat для legacy untagged корпусов.

### Архитектура

- Миграция: [migrations/007_kb_topic.sql](migrations/007_kb_topic.sql) — `ALTER TABLE kb_documents ADD COLUMN topic TEXT` + partial index
- Классификатор: [src/rag/topic-classifier.ts](src/rag/topic-classifier.ts) — `classifyTopic(q)` возвращает slug или null. 6 тем по умолчанию: `visa`, `payment`, `schedule`, `housing`, `locations`, `application`. Cyrillic-aware (Unicode property lookbehind, не `\b`)
- KB search: [src/db/repos/kb.ts](src/db/repos/kb.ts) — `search(vec, k, topic?)`, `searchBm25(query, k, topic?)`, `hybridSearch({..., topic})`
- Ingest: [`scripts/ingest.ts`](scripts/ingest.ts) поддерживает `--topic SLUG` или авто-derives из директории (`kb/curated/visa/foo.md` → topic=visa). См. [`deriveTopicFromPath`](src/rag/ingest.ts)

### Цена

- **0 LLM-вызовов** — классификатор это regex, sub-ms
- При hybrid search: топик фильтрует обе стороны (vector + BM25)
- Для vector index — over-fetch 3*k и фильтр после (sqlite-vec не комбинирует MATCH с произвольным WHERE)

### Как добавить новые темы

В [`topic-classifier.ts`](src/rag/topic-classifier.ts) добавь блок в `TOPIC_PATTERNS`. Например для темы `interview`:

```ts
{
  topic: "interview",
  pattern: new RegExp(`${NW}(собеседован|интервью|interview|видео-?звон)`, "iu"),
}
```

Slug должен совпадать с тегом, который ты используешь при ingest (директория или `--topic`). Тесты в [tests/unit/topic-classifier.test.ts](../tests/unit/topic-classifier.test.ts).

### Что важно

- Классификатор **намеренно консервативен**: при amb iguity (несколько тем) возвращает null. Лучше пропустить routing, чем форсить не ту тему.
- Telemetry: когда topic применился, в `meta_json.telemetry.topic` будет slug. В DEBUG-панели админки видно — операторы могут диагностировать "почему RAG промахнулся" по этому полю.
- Fallback на global retrieval гарантирует **monotonic recall** — включение этого слоя не уменьшает что бот находил раньше, только улучшает precision когда классификация надёжна.

---

## Все вместе

```
inbound message
   │
   ▼
[1] read user memory  → inject candidate facts into system prompt
[2] read conversation summary → inject "ИЗ РАННЕЙ ПЕРЕПИСКИ" block
   │
   ▼
[3] questionNeedsRewrite? → rewriteQuery → use rewritten for retrieval
   │
   ▼
[4] hybridSearch (BM25 + vector + RRF)
   │
   ▼
LLM with system prompt
  (persona + persona facts + summary + user facts + KB context)
   │
   ▼
[5] reflect: is the answer grounded?
   │   ├── yes → send to TG
   │   └── no → drop, stay silent
   │
   ▼
[after reply, fire-and-forget]
extract new candidate facts → mergeMemoryFacts
refresh summary if stale → setSummary
```

## Рекомендованный порядок включения

1. **Сначала** `RAG_HYBRID_SEARCH=true` — нет LLM-цены, нет риска извлечения, чистый upgrade retrieval.
2. **Если KB > 30 документов и темы делятся чисто** — `RAG_TOPIC_ROUTING=true`. Тоже нет LLM-цены. Сначала тегируй документы (`--topic` или директории), потом включай флаг.
3. **Потом** `RAG_USER_MEMORY=true` — посмотри неделю на extraction quality в админке, поправь явные ошибки.
4. **Потом** `RAG_QUERY_REWRITE=true` — особенно если у тебя длинные follow-up диалоги.
5. **Потом** `RAG_REFLECT=true` — это самый дорогой слой (по латентности — удваивает время до ответа).
6. **Если есть длинные диалоги (>30 turn'ов)** — `RAG_CONVERSATION_SUMMARY=true`. Не нужно если все чаты короткие.

Если включаешь все шесть сразу: суммарная стоимость ≈ +2.6 LLM-вызова на средний turn (rewrite — на 25% turns, reflect — на 80% grounded turns, memory extraction — на каждом turn но after-reply, summary refresh — раз в ~8 turns на длинных чатах, hybrid + topic routing — без LLM). Только reflect добавляет к latency до отправки — остальные либо after-reply, либо до retrieval (быстрая модель за <500ms).

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
| Summary | [tests/unit/summarize-conversation.test.ts](../tests/unit/summarize-conversation.test.ts) + [tests/unit/db.test.ts](../tests/unit/db.test.ts) + [tests/unit/answer.test.ts](../tests/unit/answer.test.ts) | clean parsing, refine-mode prompt, repo round-trip, prompt injection (legacy + sales) |
| Topic routing | [tests/unit/topic-classifier.test.ts](../tests/unit/topic-classifier.test.ts) + [tests/unit/hybrid-search.test.ts](../tests/unit/hybrid-search.test.ts) + [tests/unit/ingest.test.ts](../tests/unit/ingest.test.ts) + [tests/unit/answer.test.ts](../tests/unit/answer.test.ts) | classifier (Cyrillic + word boundaries + ambiguity), KbRepo topic filter, ingest topic-from-path, end-to-end routing fallback |
