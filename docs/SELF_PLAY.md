# Self-play, Pairwise & Coaching

Автоматизированный тренировочный цикл для улучшения sales-стилей без ручной разметки. Бот играет сам против себя, LLM-судья оценивает результат, ELO-рейтинг показывает что работает, coach-LLM предлагает правки, shadow A/B валидирует их статистически.

## Обзор цикла

```
self-play матч
  salesperson-LLM (style + RAG + skills)
    vs
  candidate-LLM  (persona: скептик/энтузиаст/…)
        │
        ▼ max N turns
  judge-LLM → verdict {outcome: win|loss, reason, stage_reached}
        │
        ├─ skill_outcomes: skill → win/loss
        ├─ style ELO rating ↑↓
        └─ self_play_matches: транскрипт + verdict сохранён
              │
              ▼ накопились поражения
        coach-LLM → proposal_json (конкретные правки style config)
              │
              ▼ operator approves → new style version
        shadow A/B
          base style  vs  new variant
          N pairwise матчей
          Wilson 95% lower bound
              │
              ├─ variant побеждает → activate
              └─ нет разницы → reject proposal
```

---

## Self-play матч (`orchestrator.ts`)

### Как работает

1. Выбирается style и candidate persona (или задаётся вручную).
2. Candidate-LLM генерирует первое сообщение (старт диалога).
3. Salesperson-LLM (с RAG + composeSystemPrompt + skills) отвечает.
4. Candidate реагирует на ответ.
5. Продолжается до `maxTurns` (default 20) или пока judge не получит сигнал к остановке.
6. Judge-LLM выносит вердикт.

### Candidate personas (`personas.ts`)

5 готовых типов:

| Тип | Поведение |
|---|---|
| `skeptic` | Сомневается, задаёт острые вопросы ("это не развод?") |
| `enthusiast` | Открыт, легко идёт на контакт |
| `distracted` | Отвечает коротко, отвлекается |
| `price_focused` | Всё сводит к деньгам ("сколько точно платят?") |
| `objector` | Активно возражает, требует доказательств |

### Judge (`judge.ts`)

LLM-судья получает полный транскрипт и выносит вердикт:
- `outcome`: `win` | `loss` | `stalemate`
- `reason`: почему так решил
- `stage_reached`: до какой стадии воронки дошли

### Reflection (fabrications)

Если `RAG_REFLECT=true`, каждый ответ salesperson-LLM проверяется на грounded. Непрошедшие проверку считаются `fabricationsCaught`. Счётчик сохраняется в `self_play_matches.fabrication_count` — индикатор что промпт нужно ужесточить по grounding.

### Запуск

```bash
# CLI:
bun scripts/self-play.ts
bun scripts/self-play.ts --style alina-infinity-v1
bun scripts/self-play.ts --style alina-infinity-v1 --persona skeptic

# Admin UI:
/admin/self-play → кнопка "Run match"

# Admin API:
POST /admin/api/self-play
{
  "style_id": 3,
  "persona": "price_focused",   // optional
  "maxTurns": 15                // optional
}
```

### Просмотр результатов

`/admin/self-play` — список матчей с вердиктом, persona, style, дата. Клик → полный транскрипт с раскраской по ролям.

---

## Pairwise A/B матч (`pairwise.ts`)

Головной-к-голове сравнение: **одна и та же** candidate persona, **два разных** style — кто «продаст» лучше?

### Зачем

Solo self-play сравнивает стиль с `null` — «выиграл или проиграл». Pairwise сравнивает стиль A с B на идентичных условиях. Это устраняет variance от разных persona-draws и даёт чище signal.

### Как работает

1. Одна persona-seed → два параллельных solo матча (style A и style B).
2. Оба транскрипта с одной и той же начальной позицией.
3. Judge-LLM сравнивает обоих → `winner: "a" | "b" | "tie"`.
4. Результат сохраняется в `pairwise_matches` (ссылки на оба `solo_match_id`).

### Запуск

```bash
bun scripts/pairwise.ts
bun scripts/pairwise.ts --style-a alina-infinity-v1 --style-b flirty-belfort-v1

# Admin UI: /admin/pairwise → "Run pairwise"
```

---

## ELO рейтинг (`elo.ts`)

После каждого solo match:

```
new_rating = current_rating + K * (actual - expected)
expected   = 1 / (1 + 10^((opponent_rating - my_rating) / 400))
K = 32
```

Сохраняется в `style_ratings` (один row на slug). Лидерборд виден в `/admin/styles` — сортировка по рейтингу.

---

## Coach (`coach.ts`)

LLM-коуч читает последние N проигранных матчей и предлагает конкретные правки config.

### Как работает

1. Берёт последние `COACH_LOSS_WINDOW` (default 10) проигранных solo-матчей для style.
2. Формирует промпт: транскрипты + текущий `config_json` style.
3. LLM возвращает `proposal_json` — JSON patch к Style (какие поля менять и почему).
4. Сохраняется в `coach_proposals` со статусом `pending`.

### Operator workflow

В `/admin/coach`:
- Список pending proposals с diff от текущего config.
- **Apply** → создаёт новую версию стиля (`editAsNewVersion`) + автоматически запускает shadow A/B.
- **Reject** → архивирует proposal.

### Запуск генерации

```bash
bun scripts/coach.ts
bun scripts/coach.ts --style alina-infinity-v1 --window 15

# Admin UI: /admin/coach → "Run coach"
# API: POST /admin/api/coach/run
```

---

## Shadow evaluation (`shadow-eval.ts`)

После того как operator применил coach proposal, нужно проверить: стало ли лучше, или это случайный шум?

### Метод

1. Запускаются `N` (default 20) pairwise матчей: `base_style` vs `variant_style`.
2. Собирается статистика побед.
3. Вычисляется **Wilson 95% lower bound** win rate:

```
wilson_lb = (wins + z²/2) / (total + z²)
          - z * sqrt((wins*(total-wins)/total + z²/4) / (total + z²))
where z = 1.96 (95% confidence)
```

4. Если `wilson_lb(variant) > wilson_lb(base)` — variant стабильно лучше → `status = accepted`.
5. Иначе → `status = rejected`, base_style остаётся активным.

### Просмотр

`/admin/shadow-eval` — список evaluations с progress bar (сколько матчей сыграно / требуется), текущий win rate, Wilson LB, итоговый вердикт.

### API

```bash
# Запустить:
POST /admin/api/shadow-eval/:styleId/start
{ "variantStyleId": 15, "matchCount": 20 }

# Статус:
GET /admin/api/shadow-eval/:styleId
```

---

## Skill outcomes & leaderboard

Каждый матч (solo и real conversation) атрибутирует outcome к конкретным skills, которые использовал бот:

```
self-play win  →  gradeSkills() → [social_proof_with_numbers, scarcity_limited_slots]
                  recordSkillOutcomes([...skills], outcome='win', source='self_play')

lead submitted →  attributeLeadOutcome(lead)
                  recordSkillOutcomes([...skills], outcome='win', source='real_conversation')

lead rejected  →  outcome='loss'
stale sweep    →  outcome='loss' (14d без активности)
```

### Лидерборд

`/admin/skills` показывает для каждого skill:
- Win rate (self_play + real_conversation разделены)
- Total uses
- Trending (last 7d vs overall)

Это отвечает на вопрос: «какие техники убеждения реально работают на нашем трафике?»

---

## Конфигурация

```bash
# .env — параметры self-play:
SELF_PLAY_MAX_TURNS=20          # default max turns per match
SELF_PLAY_JUDGE_TEMPERATURE=0   # judge должен быть детерминирован
COACH_LOSS_WINDOW=10            # сколько последних поражений читает coach
SHADOW_EVAL_MATCH_COUNT=20      # pairwise матчей для shadow A/B
```

---

## Testing

```
tests/unit/sales/
  self-play-orchestrator.test.ts
  self-play-judge.test.ts
  pairwise.test.ts
  elo.test.ts
  skill-outcomes.test.ts
  shadow-eval.test.ts
  coach.test.ts
```

Все тесты изолированы: mock-LLM вместо реального, `:memory:` SQLite. Self-play оркестратор тестируется с детерминированными mock-ответами от обеих сторон.
