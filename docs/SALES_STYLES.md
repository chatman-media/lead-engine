# Sales-style engine

Pluggable conversational personas с sales frameworks, Cialdini hooks, per-stage guidance, skills catalogue и few-shot anchoring. Промпт собирается at runtime, факты — из KB-grounded RAG.

## Activation

| Mode | Как | Когда |
|---|---|---|
| **Single forced style** | `BOT_SALES_STYLE=<slug>` в `.env` | демо, QA, single-persona prod |
| **Per-conversation A/B** | running row в `experiments` → детерминированный variant | реально тестируешь что конвертит лучше |
| **Off (legacy)** | ни то ни другое → `BOT_PERSONA_*` env | back-compat |

```bash
# .env — один стиль для всех:
BOT_SALES_STYLE=alina-infinity-v1
```

```bash
# A/B через Admin UI: /admin/experiments → New → Start
# Или напрямую в DB:
INSERT INTO experiments (slug, status, allocation_json, started_at)
VALUES (
  'may-2026-ab',
  'running',
  '{"alina-infinity-v1": 50, "empathetic-nepq-v1": 50}',
  unixepoch()
);
```

Откат: убрать env var или `UPDATE experiments SET status='paused'`. Существующие conversations сохраняют назначенный стиль.

---

## Built-in styles

| slug | Персона | Фреймворк | Тон |
|---|---|---|---|
| `alina-infinity-v1` | Алина, INFINITY AGENCY | NEPQ | тёплый, менеджер в личке, по-человечески |
| `flirty-belfort-v1` | Алина — флирт-рекрутер | Straight Line | тёплый, дерзкий, комплименты |
| `empathetic-nepq-v1` | Маша — эмпатичный консультант | NEPQ | спокойный, low-pressure |
| `cold-direct-pas-v1` | Игорь | PAS | сухой, без воды, без эмодзи |

Исходники: [`src/sales/styles/`](../src/sales/styles/). Каждый файл — Zod-валидированный TypeScript-объект.

---

## Style schema

```typescript
type Style = {
  slug: string           // kebab-case, immutable — ID всей version chain
  displayName: string

  persona: {
    name: string
    role: "human" | "assistant"   // human → не раскрывать что бот
    company?: string
    facts?: Record<string, string> // дополнительные факты для промпта
  }

  voice: {
    tone: string         // описание тона для LLM
    language: "ru" | "en"
    forbid: string[]     // список запрещённых слов/конструкций
  }

  framework: "AIDA" | "PAS" | "SPIN" | "NEPQ" | "straight_line"

  hooks: Array<{
    kind: "social_proof" | "scarcity" | "authority" | "liking" | "reciprocity" | "commitment"
    text: string
  }>

  stages: {
    opener?:   { goal, guidance?, groundingRequired?, maxTurns? }
    qualify?:  { goal, guidance?, groundingRequired? }
    pitch?:    { goal, guidance?, groundingRequired? }
    objection?: { goal, guidance? }
    close?:    { goal, guidance? }
  }

  fewShot: Array<{
    stage?: FunnelStage
    user: string
    assistant: string
  }>

  guardrails: {
    noMinors: boolean
    botDisclosureOnDirectQuestion: boolean
    forbiddenTopics: string[]
  }

  model: {
    id: string           // e.g., "qwen3:latest"
    temperature: number  // 0..2
    maxTokens: number
  }
}
```

### Mental model

Style — единица A/B теста. Четыре ортогональных измерения:

1. **Persona** — кто говорит (имя, роль, компания, факты).
2. **Sales framework** — структура разговора (AIDA / PAS / SPIN / NEPQ / Straight Line).
3. **Hooks** — рычаги Чалдини (social proof, scarcity, authority, liking, reciprocity, commitment).
4. **Stage** — где в воронке (opener → qualify → pitch → objection → close).

Держи три константой — варьируй одно.

---

## System prompt (что туда входит)

До 9 секций, разделённых пустой строкой:

| Секция | Всегда | Содержимое |
|---|---|---|
| persona | ✓ | имя + human/assistant role + правило бот-раскрытия |
| voice | ✓ | tone + language + список запрещённого |
| framework | ✓ | одна строка описания AIDA/PAS/SPIN/NEPQ/Belfort |
| hooks | conditional | Cialdini-усилители как «ammunition» |
| stage | ✓ | текущий stage заглавными, goal, guidance, требование grounding |
| skills | conditional | prompt_fragment активных skills для этого stage |
| guardrails | ✓ | noMinors + forbidden topics + limit длины |
| few-shot | conditional | только первый turn — сбрасывается дальше (экономит 200-500 токенов) |
| KB context | conditional | top vector hits в формате `[#1] Title\nText` |

Реализация: [`src/sales/prompt.ts`](../src/sales/prompt.ts) → `composeSystemPrompt()`.

---

## Stage routing

### Два режима

| Стратегия | Env | Стоимость | Точность |
|---|---|---|---|
| `regex` (default) | — | Sub-ms, free | Чёткие сигналы ловит хорошо |
| `llm` | `SALES_STAGE_CLASSIFIER=llm` | +1 LLM вызов (~$0.0001 на haiku) | Нюансы, которые regex пропускает |

```bash
# .env:
SALES_STAGE_CLASSIFIER=llm
SALES_STAGE_CLASSIFIER_THRESHOLD=0.6   # fallback к regex если confidence < threshold
```

### LLM classifier (`stage-classifier.ts`)

Вызывает основной `ChatClient` с JSON-output промптом. Graceful fallbacks:
- LLM throws → `llm-error`, regex fallback
- Output not parseable → `parse-error`, regex fallback
- Unknown stage → `unknown-stage`, regex fallback
- Confidence < threshold → `low-confidence`, regex fallback

Промпт classifier'а зафиксирован на `temperature: 0` — детерминирован при одном и том же вводе.

Лог каждого turn'а:
```
[sales] stage=objection source=llm confidence=0.92
[sales] stage=pitch source=regex-fallback reason=low-confidence
```

### Regex fallback (`stage-router.ts`)

Правила по приоритету:

1. `objection` regex → `objection`
2. `pricing` regex → `pitch`
3. `agreement` AND мы в qualify/pitch/objection → `close`
4. Turn 1 → `opener`. opener → `qualify`. Иначе → `currentStage`

⚠️ Кириллица: JS `\b` — ASCII-only. Используются явные Unicode-делимитеры `[^\p{L}\p{N}]` с флагом `u`. Регрессионный тест в [`tests/unit/sales/stage-router.test.ts`](../tests/unit/sales/stage-router.test.ts).

---

## Skills catalogue

Каталог техник убеждения, инжектируемых в систем промпт сверх базового stage guidance.

### Как работает

1. Каждый skill имеет `prompt_fragment` — инструкцию для LLM.
2. Для каждого style в `style_skills` помечается набор enabled skills.
3. `composeSystemPrompt()` включает только skills, enabled для текущего style.
4. Post-generation: `gradeSkills()` отдельным LLM-вызовом оценивает, какие skills реально применил бот в ответе.
5. Результат записывается в `skill_outcomes` → лидерборд в `/admin/skills`.

### Управление

В `/admin/skills`:
- просмотр каталога с win-rate каждого skill
- включение/выключение для конкретного style
- редактирование `prompt_fragment`

### Примеры skills

| slug | Описание |
|---|---|
| `social_proof_with_numbers` | «за год 200+ девушек» |
| `scarcity_limited_slots` | «осталось 3 места» |
| `reciprocity_gift_offer` | «пришлю пример договора» |
| `authority_legal_contract` | «легальный контракт, виза от агентства» |

---

## A/B routing

[`src/sales/ab-router.ts`](../src/sales/ab-router.ts) — `pickVariant(experiment, userId)`:

- Детерминированный: `hash(experiment.slug + userId) mod totalWeight` → всегда одно и то же распределение.
- Sticky: `style_id` и `experiment_id` сохраняются на conversation row. Рестарт сервера / другой процесс — тот же вариант.
- Proportional: integer веса в `allocation_json`.

Когда experiment `running` — каждый NEW conversation автоматически получает variant при первом сообщении.

### Funnel аналитика

`GET /admin/api/experiments/:id/funnel` — per-style агрегаты: conversations · qualified · won · lost · human-handoff rate.

---

## Style versioning

Редактирование style создаёт **новую row** (version+1, parent_id=currentId), старая маркируется is_active=0.

```
┌─────────────────────────────────────────────────────────┐
│  slug="alina-infinity-v1"                               │
│                                                         │
│  v1 (id=1)  is_active=0  parent_id=null   ← historical │
│    └─► v2 (id=7)  is_active=0  parent_id=1             │
│           └─► v3 (id=15) is_active=1  parent_id=7 ← current │
└─────────────────────────────────────────────────────────┘
```

- Conversations пинненные к старой версии продолжают видеть тот же промпт.
- `bySlug()` возвращает только `is_active=1` → новые conversations получают v3.
- `byId()` возвращает любую версию → audit / history view.
- `editAsNewVersion()` атомарный: транзакция, оба op либо commit либо rollback.

### Boot-time seed

`seedBuiltinStyles()` вызывается при каждом старте сервера:
- Новый slug → INSERT.
- Существующий + `config_json` изменился → UPDATE `config_json` (admin's `display_name` edits сохраняются).
- Без изменений → skip.

Это значит: редактирование стиля в коде и рестарт сервера → изменение применяется. Редактирование через Admin UI → сохраняется в DB и побеждает после следующего edit через Admin UI (code refresh пересинхронизирует только если файл поменялся).

---

## Authoring a new style

```typescript
// src/sales/styles/my-style-v1.ts
import { type Style, StyleSchema } from "../types.ts";

export const myStyle: Style = StyleSchema.parse({
  slug: "my-style-v1",          // kebab-case, уникальный
  displayName: "Саша — пример",
  persona: {
    name: "Саша",
    role: "human",
    company: "EXAMPLE AGENCY",
    facts: { phone: "+7 999 000 0000" },
  },
  voice: {
    tone: "дружелюбный, коротко, без формализма",
    language: "ru",
    forbid: ["Здравствуйте", "Добрый день", "оператор", "ИИ"],
  },
  framework: "NEPQ",
  hooks: [
    { kind: "social_proof", text: "работаем с 500+ кандидатами" },
    { kind: "scarcity", text: "набираем только 5 человек в потоке" },
  ],
  stages: {
    opener: {
      goal: "представиться и узнать что интересует",
      guidance: "Одна реплика, без продажи.",
      maxTurns: 1,
    },
    qualify: {
      goal: "узнать возраст, город, готовность",
      guidance:
        "ПРАВИЛО 1: Один вопрос в конце реплики.\n" +
        "ПРАВИЛО 2: Не повторяй то, что уже сказали.\n" +
        "ПРАВИЛО 3: Как только есть возраст + город — переходи к pitch.",
      groundingRequired: false,
    },
    pitch: {
      goal: "рассказать вакансию по АКТУАЛЬНЫЕ ВАКАНСИИ",
      guidance:
        "Цифры только из АКТУАЛЬНЫЕ ВАКАНСИИ или KB. " +
        "Если кандидат соглашается («Да», «ок») — продолжай питч. " +
        "ВСЕГДА прикладывай ссылку из поля «Ссылка:».",
      groundingRequired: false,
    },
    objection: {
      goal: "снять страх",
      guidance: "Признай по-человечески, дай конкретный proof, мягкий мост к close.",
    },
    close: {
      goal: "договориться на следующий шаг",
      guidance: "Один мягкий CTA. Не уговаривай.",
    },
  },
  fewShot: [
    {
      stage: "opener",
      user: "привет",
      assistant: "Привет! Я Саша из EXAMPLE. Что интересует?",
    },
  ],
  guardrails: {
    noMinors: true,
    botDisclosureOnDirectQuestion: false,
    forbiddenTopics: ["sexual_explicit", "minors", "fake_documents"],
  },
  model: {
    id: "qwen3:latest",
    temperature: 0.65,
    maxTokens: 280,
  },
});
```

Зарегистрировать в [`src/sales/styles/index.ts`](../src/sales/styles/index.ts):

```typescript
import { myStyle } from "./my-style-v1.ts";
export const STYLES = [...EXISTING_STYLES, myStyle];
```

Zod-схема валидируется при загрузке модуля — ошибка в структуре → краш с field-level сообщением, не при первом сообщении пользователя.

---

## Guardrails

- `noMinors: true` — запрещает любое взаимодействие с несовершеннолетними. Проверяется в `guardrails.ts`.
- `botDisclosureOnDirectQuestion: false` — прямой вопрос «ты бот?» обрабатывается детерминистически через `botPresenceReply` shortcut **до** LLM (см. `webhook.ts`), независимо от этого флага. Флаг контролирует поведение при косвенных намёках в промпте.
- `forbiddenTopics` — список тем, по которым LLM не должна отвечать.

---

## Testing

`tests/unit/sales/` зеркалирует `src/sales/`:

| Файл теста | Что тестируется |
|---|---|
| `ab-router.test.ts` | детерминизм, distribution, edge cases |
| `stage-router.test.ts` | кириллица regression, все переходы, приоритет правил |
| `stage-classifier.test.ts` | 4 fallback пути, threshold, парсинг LLM output |
| `prompt.test.ts` | все секции, persona-role branching, few-shot toggle, KB block |
| `styles.test.ts` | все 4 built-in styles + Zod rejection bad input |
| `styles-repo.test.ts` | CRUD, parseRow, soft-delete, idempotent seed, editAsNewVersion |
| `experiments-repo.test.ts` | CRUD, getRunning, allocation parsing |
| `webhook-ab.test.ts` | E2E A/B: assignment, stickiness, graceful fallback |
| `admin-sales-api.test.ts` | 47 тестов, все 9 sales endpoints + version-pin invariant |

Суммарно 150+ тестов. `bun test tests/unit/sales/` — изолировано, `:memory:` SQLite.
