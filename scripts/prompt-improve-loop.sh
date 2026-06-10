#!/usr/bin/env bash
# Ralph-loop авто-улучшения промптов (#517).
#
# Цикл: гипотеза → гейт → commit/rollback. Каждая итерация — свежий headless
# Claude Code (чистый контекст, маленький шаг); backpressure — typecheck +
# тесты затронутых пакетов (+ опциональный пользовательский бенчмарк).
# Журнал docs/engineering/prompt-loop-log.md накапливает гипотезы между
# итерациями и запусками: следующая итерация читает его и не повторяется.
# Подробности: docs/engineering/PROMPT_IMPROVE_LOOP.md
#
# Использование:
#   ITERATIONS=5 ./scripts/prompt-improve-loop.sh
#   TARGET="reflect/fact-check промпты в packages/kb/src" ./scripts/prompt-improve-loop.sh
#   GATE_EXTRA_CMD="bun run quality:tool-regressions --file corpus.jsonl" ./scripts/prompt-improve-loop.sh
#
# Скрипт коммитит только локально и никогда не пушит. Запускать на чистом
# рабочем дереве, на отдельной ветке.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ITERATIONS="${ITERATIONS:-5}"
TARGET="${TARGET:-системные промпты (module-level *_PROMPT / systemPrompt константы) в packages/kb/src и packages/sales/src}"
LOG_FILE="${LOG_FILE:-docs/engineering/prompt-loop-log.md}"
GATE_EXTRA_CMD="${GATE_EXTRA_CMD:-}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
HYP_FILE="$(mktemp -t prompt-loop-hypothesis)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: рабочее дерево должно быть чистым (гейт откатывает через git reset --hard)" >&2
  exit 1
fi

# Backpressure: то, что удерживает цикл от деградации. Пакеты с промптами +
# их прямой потребитель. GATE_EXTRA_CMD — место для живого бенчмарка
# (golden eval с реальным LLM-ключом, tool-regressions по корпусу и т.п.).
gate() {
  bun run --cwd packages/kb typecheck &&
    bun run --cwd packages/sales typecheck &&
    bun run --cwd packages/conversation-engine typecheck &&
    bun run --cwd packages/kb test &&
    bun run --cwd packages/sales test &&
    bun run --cwd packages/conversation-engine test &&
    { [ -z "$GATE_EXTRA_CMD" ] || eval "$GATE_EXTRA_CMD"; }
}

append_log() { # $1 = verdict (kept|reverted|no-op), $2 = hypothesis text
  {
    echo "## $(date -u '+%Y-%m-%d %H:%M') UTC — ${1}"
    echo ""
    echo "${2}"
    echo ""
  } >>"$LOG_FILE"
}

for i in $(seq 1 "$ITERATIONS"); do
  echo "=== iteration ${i}/${ITERATIONS} ==="
  : >"$HYP_FILE"

  # Свежий контекст на каждую итерацию — журнал вместо памяти разговора.
  "$CLAUDE_BIN" -p "Ты участвуешь в цикле авто-улучшения промптов проекта lead-engine.

1. Прочитай журнал прошлых гипотез: ${LOG_FILE} (если есть). НЕ повторяй гипотезы, которые уже пробовались (kept или reverted).
2. Выбери ОДНУ конкретную гипотезу улучшения в зоне: ${TARGET}.
3. Внеси МИНИМАЛЬНУЮ правку: только текст промпта (формулировки, структура, примеры, порядок инструкций). НЕ трогай логику кода, типы, сигнатуры, тесты.
4. Запиши гипотезу одной строкой (что поменял и почему это должно помочь) в файл: ${HYP_FILE}

Если осмысленных новых гипотез не осталось — ничего не меняй и запиши в ${HYP_FILE} строку: EXHAUSTED <причина>." \
    --permission-mode acceptEdits || true

  HYPOTHESIS="$(cat "$HYP_FILE" 2>/dev/null || true)"
  [ -n "$HYPOTHESIS" ] || HYPOTHESIS="(гипотеза не записана)"

  case "$HYPOTHESIS" in
  EXHAUSTED*)
    echo "loop exhausted: $HYPOTHESIS"
    git reset --hard -q HEAD
    append_log "no-op" "$HYPOTHESIS"
    break
    ;;
  esac

  if git diff --quiet && git diff --cached --quiet; then
    echo "no changes produced — skip"
    append_log "no-op" "$HYPOTHESIS"
    continue
  fi

  if gate; then
    append_log "kept" "$HYPOTHESIS"
    git add -A
    git commit -q -m "quality(prompt-loop): ${HYPOTHESIS%%$'\n'*}" \
      -m "Итерация ${i} prompt-improve-loop (#517). Гейт зелёный." \
      -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
    echo "KEPT: $HYPOTHESIS"
  else
    git reset --hard -q HEAD
    git clean -qfd packages apps
    append_log "reverted" "$HYPOTHESIS"
    git add "$LOG_FILE"
    git commit -q -m "quality(prompt-loop): журнал — отклонена гипотеза (итерация ${i})" \
      -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
    echo "REVERTED: $HYPOTHESIS"
  fi
done

rm -f "$HYP_FILE"
echo "done — журнал: ${LOG_FILE}; коммиты только локальные, ревью перед push обязателен"
