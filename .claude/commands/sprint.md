---
description: Прогнать спринт по доске Lead Engine — взять карточки Todo и провести их через дизайн → код+PR → ревью+QA силами команды агентов.
argument-hint: "[кол-во карточек] (по умолчанию из board.config.json, обычно 3)"
allowed-tools: Bash, Read, Workflow
---

Ты — **скрам-мастер/оркестратор**. Эта команда УПОЛНОМОЧИВАЕТ и ТРЕБУЕТ вызвать инструмент **Workflow** для прогона спринта силами команды ролей-субагентов. Действуй строго по шагам ниже, не импровизируй с GitHub-мутациями вручную помимо хелпера.

Аргумент: `$ARGUMENTS` — желаемое число карточек на спринт (если пусто — возьми `sprint.defaultCardLimit` из конфига).

## Шаги

1. **Прочитай конфиг доски:**
   `bun .claude/scrum/board.mjs config`
   Запомни: `repo`, `defaultBase`, `sprint.defaultCardLimit`, `sprint.maxParallel`, `qa.commands`, `autoMerge`.

2. **Покажи состояние доски:**
   `bun .claude/scrum/board.mjs status`

3. **Возьми карточки из Todo:**
   `bun .claude/scrum/board.mjs list "Todo"`
   - Отсортируй по номеру issue (меньший = раньше). Возьми top-N (N = аргумент или defaultCardLimit; не больше `sprint.maxParallel` за один прогон).
   - Бери только карточки типа Issue с номером. DraftIssue без номера — пропусти и отметь.
   - Если Todo пуст → сообщи об этом и **остановись** (предложи `/groom` для пополнения из Backlog).

4. **Подтяни тело каждой выбранной карточки:**
   для каждой — `bun .claude/scrum/board.mjs issue <number>` (нужны title, body, labels, url).

5. **Двинь выбранные карточки Todo → In Progress** (по одной):
   `bun .claude/scrum/board.mjs move <itemId> "In Progress"`

6. **Запусти конвейер команды через Workflow.** Вызови инструмент Workflow:
   - `scriptPath`: `.claude/scrum/sprint.workflow.js`
   - `args`: объект
     ```json
     {
       "cards": [ { "itemId": "...", "number": 123, "title": "...", "url": "...", "body": "...", "labels": ["..."] } ],
       "repo": "<repo из конфига>",
       "base": "<defaultBase>",
       "qaCommands": [ "<из qa.commands>" ]
     }
     ```
   Дождись результата (массив по карточкам: card, spec, plan, impl, review, qa, skipped).

7. **Разнеси результаты по доске.** Для каждого элемента:
   - Составь ОДИН сводный комментарий к issue и запости:
     `bun .claude/scrum/board.mjs comment <number>` (тело — на stdin), включи:
     **Дизайн** (проблема + критерии приёмки), **План** (подход + шаги), **PR** (ссылка), **Ревью** (вердикт + ключевые находки), **QA** (вердикт + упавшие проверки). Подпиши «🤖 scrum-команда».
   - Если есть PR и были находки ревью/QA — продублируй их кратко в PR: `gh pr comment <pr> --repo <repo> --body "<…>"`.
   - **Переход карточки:**
     - `impl.success && review.verdict=="approve" && (qa.verdict=="pass" || qa.verdict=="blocked_infra")` → `move <itemId> "In Review"` (ждёт мёржа человеком). Если `qa.verdict=="blocked_infra"` — в комментарии явно отметь, что стенд красный по ПРЕД-СУЩЕСТВУЮЩЕЙ инфра-причине (не по вине PR, с доказательством от QA), и при возможности заведи/упомяни отдельную задачу на починку инфраструктуры.
     - `qa.verdict=="fail"` (сломано по вине PR), либо `review.verdict=="changes_requested"`, либо `impl.success==false` → `move <itemId> "Todo"` и в комментарии чётко перечисли блокеры (что чинить в следующий заход).
   - **PR НЕ мёржи** (autoMerge=false): мёрж и переход в Done — за человеком (issue закроется по `Closes #…`). Если autoMerge=true в конфиге — всё равно сначала спроси у пользователя явное подтверждение, мёрж необратим.

8. **Итог пользователю** — компактная таблица:
   `#issue | заголовок | PR | review | qa | новый статус` и одной строкой что требует внимания человека (PR на мёрж / карточки вернулись в Todo).

## Важно
- Все перемещения карточек и комментарии — только через `bun .claude/scrum/board.mjs` (там зашиты ID полей).
- Карточки, которые не смогли довести до PR, честно возвращай в Todo с причиной — не оставляй висеть в In Progress без объяснения.
