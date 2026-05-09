# Architecture

Высокоуровневая карта проекта. Один Telegram-бот с RAG, sales-style engine, операторской админкой, самообучением через self-play и опциональным userbot-режимом. Всё на Bun + SQLite (+ расширение `sqlite-vec`).

## Request lifecycle (webhook)

```
Telegram update
   │
   ▼
POST /telegram/<secret>   ─┬─► whitelist (UsersRepo.byTgId / TELEGRAM_OPEN_ACCESS)
                           │
                           ├─► messages.addUserMessageIfNew  (idempotent по tg_message_id)
                           │
                           ├─► escalation trigger? → mode=queued, return
                           │
                           └─► ack 200 + detached processInbound() ───────────────┐
                                                                                   │
                                                                                   ▼
                                                           ┌──────────────────────────────────────────┐
                                                           │  resolveStyle  env ▸ DB slug ▸ A/B       │
                                                           │  classifyStage  regex / LLM              │
                                                           │  users.getMemory      (USER_MEMORY)      │
                                                           │  conversations.getSummary  (CONV_SUMMARY) │
                                                           │  rewriteQuery         (QUERY_REWRITE)    │
                                                           │  classifyTopic        (TOPIC_ROUTING)    │
                                                           │  kb.hybridSearch      (HYBRID_SEARCH)    │
                                                           │  composeSystemPrompt                     │
                                                           │  chat.complete  →  sanitize              │
                                                           │  verifyAnswer         (REFLECT)          │
                                                           └──────────────────────────────────────────┘
                                                                                   │
                                                         ┌─────────────────────────┼──────────────────┐
                                                         ▼                         ▼                  ▼
                                                   send to TG            NO_CONTEXT_MARKER       ungrounded
                                                         │                      (silent)           (silent)
                                                         └─► fire-and-forget:
                                                                extractUserFacts → mergeMemoryFacts
                                                                gradeSkills → recordSkillOutcome
                                                                summarizeConversation
                                                                intakeCheck → leadStateTransition
                                                                kb-suggestion if NO_CONTEXT
```

Все RAG-надстройки **опциональны** и независимы. Подробности — [RAG_LAYERS.md](RAG_LAYERS.md).

## Слои

```
┌──────────────────────────── HTTP / WebSocket ─────────────────────────────┐
│  src/server.ts    createServer(): Bun.serve + WS upgrade + security headers│
│  src/router.ts    мини-роутер с :params extraction                        │
│  src/app.ts       регистрация всех routes (admin, telegram, ws, UI)       │
└────────────────────────────────────────────────────────────────────────────┘
         │                         │                         │
         ▼                         ▼                         ▼
┌──────────────────┐  ┌────────────────────────┐  ┌──────────────────────┐
│  telegram/       │  │  admin/                │  │  questionnaire/      │
│    webhook.ts    │  │    api.ts  (50+ REST)  │  │    routes.ts         │
│    client.ts     │  │    auth.ts (sessions)  │  │    /q/:token         │
│    userbot.ts    │  │    bus.ts  (WS pub/sub)│  └──────────────────────┘
│    escalation.ts │  └────────────────────────┘
└──────────────────┘
         │                         │
         └──────────┬──────────────┘
                    ▼
┌──────────────────────────────── domain layer ──────────────────────────────┐
│                                                                             │
│  rag/                                 sales/                               │
│    answer.ts    (entry point)           types.ts   (Style schema, Zod)     │
│    chat.ts      (ChatClient iface)      prompt.ts  (composeSystemPrompt)   │
│    embed.ts     (EmbeddingClient)       stage-router.ts  (regex)           │
│    reflect.ts   (grounding check)       stage-classifier.ts  (LLM)        │
│    rewrite-query.ts                     ab-router.ts  (deterministic)      │
│    extract-user-facts.ts                elo.ts  (ELO ratings)              │
│    summarize-conversation.ts            skills/catalogue.ts                │
│    topic-classifier.ts                  styles/  (4 built-in styles)       │
│    text-style-rules.ts                  coach.ts  (coach-LLM proposals)    │
│    chunk.ts / ingest.ts / parse-pdf.ts  shadow-eval.ts                     │
│    providers/  (ollama, openai, openrouter)                                │
│                                       self-play/                           │
│                                         orchestrator.ts                    │
│                                         judge.ts                           │
│                                         pairwise.ts                        │
│                                         personas.ts                        │
│                                                                             │
│  leads/                                                                     │
│    service.ts   (state machine)                                             │
│    intake.ts    (auto-extraction)                                           │
│    visa-docs.ts (27-field parser)                                           │
│    stale-sweep.ts  (background job)                                         │
│    outcome-attribution.ts                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────── data layer ─────────────────────────────────┐
│  db/                                                                         │
│    sqlite.ts          (Bun.Database + sqlite-vec extension)                  │
│    migrate.ts         (file-based migration runner, sequential)              │
│    ensure-kb-vec.ts   (auto-recreate kb_vec on embedding dim change)         │
│    repos/ (21 DAOs):                                                         │
│      users.ts            conversations.ts        messages.ts                 │
│      kb.ts               admins.ts               sessions.ts                 │
│      styles.ts           experiments.ts          skills.ts                   │
│      vacancies.ts        leads.ts                lead-notes.ts               │
│      questionnaire-tokens.ts  kb-suggestions.ts  skill-outcomes.ts          │
│      self-play-matches.ts     pairwise-matches.ts style-ratings.ts           │
│      coach-proposals.ts       shadow-evaluations.ts  userbot-session.ts     │
└──────────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────── persistence ─────────────────────────────────────┐
│  data/bot.db (SQLite, WAL)                                                   │
│                                                                               │
│  Users & conversations                                                        │
│    users / conversations / messages                                           │
│  Knowledge base                                                               │
│    kb_documents / kb_chunks / kb_vec / kb_chunks_fts                         │
│  Sales engine                                                                 │
│    styles / experiments / skills / style_skills                               │
│    skill_outcomes / self_play_matches / pairwise_matches                      │
│    coach_proposals / shadow_evaluations                                       │
│  Leads                                                                        │
│    leads / lead_events / lead_notes                                           │
│  Operations                                                                   │
│    vacancies / admins / sessions / questionnaire_tokens / kb_suggestions      │
│    userbot_session                                                            │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Data layer

### Таблицы

| Таблица | Назначение |
|---------|-----------|
| `users` | Telegram-юзеры. `status` для воронки; `profile_json.memory.facts` — cross-session память кандидата |
| `conversations` | Одна на юзера. `mode` ∈ ai/queued/human; `current_stage` (funnel); `style_id` + `experiment_id` (A/B sticky); `summary_json` (сжатая история) |
| `messages` | `role` ∈ user/assistant/human/system. Idempotent по `(conversation_id, tg_message_id)`. `meta_json` хранит `used_chunk_ids`. `stage` для funnel-аналитики |
| `kb_documents` | KB-документы: source path, `content_hash` (SHA-256 dedup), optional `topic` тег |
| `kb_chunks` | Чанки ≈1500 символов, overlap 150 |
| `kb_vec` | sqlite-vec virtual table (L2, dim из конфига) |
| `kb_chunks_fts` | FTS5 BM25 index; синхронизирован тремя INSERT/UPDATE/DELETE триггерами |
| `kb_suggestions` | Очередь вопросов без ответа (когда RAG вернул NO_CONTEXT) — оператор решает что добавить в KB |
| `styles` | Sales-style configs в JSON. `(slug, version)` composite key — цепочка версий; одна активная на slug |
| `experiments` | A/B эксперименты: slug, allocation JSON, status, success metric |
| `skills` | Каталог техник убеждения. `prompt_fragment` инжектируется в system prompt |
| `style_skills` | Пересечение: какие skills включены для какого style |
| `skill_outcomes` | Post-attribution: skill → outcome (win/loss), source (real_conversation/self_play) |
| `self_play_matches` | Транскрипты self-play матчей + judge verdict + fabrication count |
| `pairwise_matches` | Head-to-head A/B матчи (два solo_match_id → winner) |
| `coach_proposals` | Предложения coach-LLM: `proposal_json`, status (pending/approved/rejected/applied) |
| `shadow_evaluations` | Post-coach A/B валидация: base vs variant, статус, pairwise match IDs |
| `leads` | Воронка кандидата: `state` machine, `intake_json` (7 полей), `visa_docs_json` (27 полей), `application_id` |
| `lead_events` | Аудит-трейл переходов состояний |
| `lead_notes` | Операторские аннотации к лиду |
| `vacancies` | Быстро-меняющиеся вакансии. Prepended к RAG context на каждом turn. `url` — ссылка для кандидата |
| `admins` | Операторские аккаунты (argon2id, Bun.password) |
| `sessions` | Admin session cookies (HttpOnly, TTL 14d) |
| `questionnaire_tokens` | One-shot токены для `/q/:token` |
| `userbot_session` | MTProto session string (gramjs StringSession). Одна строка (id=1) |

### Миграции (21 файл, `migrations/`)

```
001_init.sql                  — базовые таблицы
002_idempotent_user_messages  — unique(conversation_id, tg_message_id)
003_sales_styles_and_experiments
004_style_versioning          — (slug, version) UNIQUE + partial UNIQUE(slug) WHERE is_active=1
005_kb_fts                    — FTS5 virtual table + 3 sync triggers
006_conversation_summary
007_kb_topic                  — kb_chunks.topic
008_vacancies
009_leads                     — state machine
010_lead_events
011_lead_notes
012_vacancies_url
013_kb_suggestions
013_skills                    — skills + style_skills
014_skill_outcomes
015_skill_outcomes_self_play  — allow source='self_play'
016_self_play_matches
017_self_play_fabrications    — matches.fabrication_count
018_pairwise_matches
018_userbot_session
019_coach_proposals
020_shadow_evaluations
```

## Self-play training loop

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         SELF-PLAY LOOP                                   │
│                                                                          │
│  Candidate persona (LLM)  ◄──────────────────────────────────────────┐  │
│          │ user message                                                │  │
│          ▼                                                             │  │
│  Salesperson (salesperson-LLM + RAG + style)                          │  │
│          │ assistant reply                                             │  │
│          └───────────────────────────────────────────────────────────►│  │
│                                                                          │
│  Max N turns → Judge-LLM → verdict {outcome, reason}                    │
│                    │                                                     │
│                    ├── win   → skill_outcomes (win) + ELO ↑             │
│                    └── loss  → skill_outcomes (loss) + ELO ↓            │
│                                                                          │
│  Pairwise mode: same persona × 2 styles → head-to-head winner           │
│                                                                          │
│  Coach: reads recent losses → proposes style edits → operator approves  │
│       → new style version → shadow A/B (Wilson 95% LB) → accept/reject  │
└──────────────────────────────────────────────────────────────────────────┘
```

Подробности — [SELF_PLAY.md](SELF_PLAY.md).

## Ключевые design decisions

### Stateless webhook, sticky DB state

Webhook ackает Telegram в <100ms (Bot API таймаут 60s, retries дублируют сообщения). Тяжёлая обработка (RAG → LLM → sendMessage) detached в `processInbound()`. State (mode, current_stage, style_id, memory, summary) хранится в БД — рестарты сервера ничего не теряют.

### Один conversation на user

`conversations.ensureForUser(userId)` идемпотентна. Если оператор удалил conversation — следующее сообщение создаст новый, но `users.profile_json.memory` сохраняется (привязана к `users.id`, не к `conversations.id`).

### Two-tier system prompt

- **Legacy persona** (`buildSystemPrompt`) — простой промпт из `BOT_PERSONA_*` env vars. Достаточно для одного бота с одной воронкой.
- **Sales-style engine** (`composeSystemPrompt`) — богатый: persona + voice + framework + Cialdini hooks + per-stage guidance + skills + few-shot + KB context. Style побеждает persona когда оба заданы.

### NO_CONTEXT — silent, не stall

Когда RAG не находит контекст ИЛИ reflection детектит галлюцинацию, бот **молчит**. Conversation остаётся в `mode=ai`, следующее сообщение снова пробует RAG. Эскалация на оператора — только по явным ключевым словам кандидата (`escalation.ts`). Незнакомые вопросы попадают в `kb_suggestions` — оператор видит их в `/admin/kb/suggestions` и решает что добавить в KB.

### Pluggable LLM providers, decoupled chat ↔ embeddings

`LLM_PROVIDER` управляет чатом, `EMBEDDING_PROVIDER` — embeddings. OpenRouter не имеет `/embeddings` endpoint'а, поэтому в смешанных конфигурациях (OpenRouter chat + Ollama embed) оба провайдера конфигурируются независимо.

| Chat | Embed | Use case |
|------|-------|----------|
| OpenAI | OpenAI | стандарт |
| OpenRouter | Ollama | Claude/GPT в облаке + локальные дешёвые embeddings |
| OpenRouter | OpenAI | всё в облаке через OpenRouter |
| Ollama | Ollama | full-local, без расхода токенов |

### Style versioning — immutable history

Редактирование style создаёт новую row (version+1, parent_id=текущий), старая маркируется is_active=0. Conversations, пинненные к старой версии, продолжают видеть тот же промпт. Новые conversations получают новую. Atomic: транзакция в `StylesRepo.editAsNewVersion()`.

### Operator-first UI

Ключевые операции:
- `Take over` → `mode=human`, бот замолкает, оператор пишет в TG
- `Release` → `mode=ai`, бот возобновляет
- MEMORY pane — правка того, что бот «знает» о кандидате
- WS `/admin/api/ws` — real-time события без polling

### Userbot mode

Когда `TELEGRAM_USERBOT=1`, gramjs-клиент подключается как личный аккаунт. Каждое входящее `NewMessage` создаёт per-message sender с замыканием на `msg.reply()` — это обходит "could not find input entity" ошибку gramjs (numeric userId без access_hash). Сессия хранится в `userbot_session` таблице.

## Тестовая стратегия

| Уровень | Инструмент | Объём |
|---------|-----------|-------|
| Unit | `bun test` | 807+ тестов, `tests/unit/` (58 файлов) |
| E2E | Playwright | 14+ тестов, `tests/e2e/` |
| Build | `bun run build:ui` | Vite сборка React-админки |
| Type check | `bunx tsc --noEmit` | TypeScript strict |

Unit-тесты изолированы: `:memory:` SQLite, мок-LLM клиенты, никакой сети. Каждый модуль с нетривиальной логикой — отдельный test-файл в `tests/unit/`, зеркалирующий структуру `src/`.

E2E-тесты поднимают сервер на отдельном порту (`E2E_PORT`, default 3100) с тестовой БД и `TEST_HOOKS=1`. `/__test/*` seed-эндпоинты доступны только при этом флаге.

## Documentation map

| Файл | Что |
|---|---|
| [../README.md](../README.md) | Setup guide: env, CLI, KB pipeline, провайдеры |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Этот файл |
| [RAG_LAYERS.md](RAG_LAYERS.md) | 6 opt-in RAG надстроек |
| [SALES_STYLES.md](SALES_STYLES.md) | Style schema, skills, A/B, промпт |
| [SELF_PLAY.md](SELF_PLAY.md) | Self-play, pairwise, coaching, shadow eval |
| [LEADS.md](LEADS.md) | Lead state machine, intake/visa-docs, relay |
| [USERBOT.md](USERBOT.md) | MTProto userbot setup |
| [DEPLOY.md](DEPLOY.md) | Docker, nginx, backups |
| [ROADMAP.md](ROADMAP.md) | Что сделано, что в очереди |
