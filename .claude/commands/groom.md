---
description: Груминг бэклога — оценить карточки Backlog силами triage-агентов и предложить, что поднять в Todo.
argument-hint: "[кол-во карточек Backlog для оценки] (по умолчанию 5)"
allowed-tools: Bash, Read, Agent
---

Ты — скрам-мастер на груминге. Цель — превратить сырой Backlog в готовые к спринту карточки Todo. Действуй по шагам.

Аргумент: `$ARGUMENTS` — сколько карточек Backlog оценить (если пусто — 5).

## Шаги

1. `bun .claude/scrum/board.mjs status` — общая картина.
2. `bun .claude/scrum/board.mjs list "Backlog"` — карточки бэклога. Возьми top-N по номеру (только Issue с номером).
3. Для каждой подтяни тело: `bun .claude/scrum/board.mjs issue <number>`.
4. Запусти **triage-агента на каждую карточку** (параллельно, в одном сообщении несколько Agent-вызовов; `subagent_type: "triage"`). Передай агенту title/body/labels/url. Каждый вернёт: clarity, readyForTodo, size, priority, blockers, clarifyingQuestions, rationale.
5. Собери результаты в таблицу пользователю: `#issue | size | priority | readyForTodo | блокеры/вопросы`.
6. **Рекомендация:** какие карточки поднять Todo (readyForTodo=true, нет блокеров), какие требуют уточнения.
7. Подними в Todo **только то, что пользователь подтвердит** (не двигай молча). После подтверждения:
   - `bun .claude/scrum/board.mjs move <itemId> "Todo"` для согласованных карточек.
   - для сырых — предложи запостить уточняющие вопросы комментарием (`bun .claude/scrum/board.mjs comment <number>`), тоже после подтверждения.

После груминга подскажи: запустить спринт командой `/sprint`.
