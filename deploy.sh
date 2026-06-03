#!/usr/bin/env bash
#
# deploy.sh — деплой lead-engine на сервере.
# Кодифицирует docs/SERVER_RUNBOOK.md: pull → install → migrate → build → restart → health.
#
# Использование:
#   ./deploy.sh                 # полный деплой
#   ./deploy.sh --no-restart    # без рестарта сервисов
#   ./deploy.sh --no-test       # пропустить тесты (по умолчанию и так пропущены)
#   ./deploy.sh --test          # прогнать тесты перед рестартом
#   ./deploy.sh --skip-build    # только pull + миграции
#
# Настройка через env (можно положить в /opt/lead-engine/.deploy.env):
#   APP_DIR        каталог репозитория        (default: /opt/lead-engine)
#   GIT_BRANCH     ветка для деплоя           (default: main)
#   API_SERVICE    systemd-юнит API           (default: lead-engine-api)
#   WORKER_SERVICE systemd-юнит worker        (default: lead-engine-worker)
#   HEALTH_URL     URL для проверки           (default: $PLATFORM_PUBLIC_URL/healthz)

set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/opt/lead-engine}"
GIT_BRANCH="${GIT_BRANCH:-main}"
API_SERVICE="${API_SERVICE:-lead-engine-api}"
WORKER_SERVICE="${WORKER_SERVICE:-lead-engine-worker}"

DO_RESTART=1
DO_BUILD=1
DO_TEST=0

for arg in "$@"; do
  case "$arg" in
    --no-restart) DO_RESTART=0 ;;
    --skip-build) DO_BUILD=0 ;;
    --test)       DO_TEST=1 ;;
    --no-test)    DO_TEST=0 ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# подхватить локальный env-файл, если он есть
[ -f "$APP_DIR/.deploy.env" ] && set -a && . "$APP_DIR/.deploy.env" && set +a

HEALTH_URL="${HEALTH_URL:-${PLATFORM_PUBLIC_URL:-}/healthz}"

# ── helpers ──────────────────────────────────────────────────────────────────
log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$APP_DIR" || die "нет каталога $APP_DIR"

command -v bun >/dev/null || die "bun не найден в PATH"

# ── 1. проверка обязательных env ─────────────────────────────────────────────
log "Проверка env"
: "${DATABASE_URL:?DATABASE_URL не задан}"
: "${PLATFORM_MASTER_KEY:?PLATFORM_MASTER_KEY не задан}"
# PLATFORM_MASTER_KEY менять на живом сервере нельзя — старые секреты не расшифруются.
ok "DATABASE_URL и PLATFORM_MASTER_KEY заданы"
[ -n "${PLATFORM_PUBLIC_URL:-}" ] || echo "  ⚠ PLATFORM_PUBLIC_URL не задан — health-check пропустим"

# ── 2. обновить код и зависимости ────────────────────────────────────────────
log "Git pull ($GIT_BRANCH)"
git fetch origin
git checkout "$GIT_BRANCH"
git pull --ff-only origin "$GIT_BRANCH"
ok "Код на $(git rev-parse --short HEAD)"

log "bun install"
bun install --frozen-lockfile
ok "Зависимости установлены"

# ── 3. миграции (ВСЕГДА --keep-data на сервере) ──────────────────────────────
# Без --keep-data скрипт делает DROP SCHEMA public CASCADE — снесёт прод.
log "Миграции (--keep-data)"
DATABASE_URL="$DATABASE_URL" bun run apps/api/scripts/reset-and-migrate.ts --keep-data
ok "Миграции применены"

# ── 4. сборка ────────────────────────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  log "Typecheck"
  bun run typecheck
  log "Сборка пакетов"
  bun run build:packages
  log "Сборка admin-ui"
  bun run build:ui
  log "Сборка widget"
  bun run build:widget
  ok "Сборка завершена"
else
  echo "  ⏭ сборка пропущена (--skip-build)"
fi

if [ "$DO_TEST" -eq 1 ]; then
  log "Тесты"
  DATABASE_URL="$DATABASE_URL" bun run --filter './apps/*' test
  ok "Тесты прошли"
fi

# ── 5. рестарт процессов ─────────────────────────────────────────────────────
if [ "$DO_RESTART" -eq 1 ]; then
  if command -v systemctl >/dev/null; then
    log "Рестарт сервисов"
    sudo systemctl restart "$API_SERVICE"
    sudo systemctl restart "$WORKER_SERVICE"
    sleep 2
    sudo systemctl --no-pager --lines=0 status "$API_SERVICE"    || true
    sudo systemctl --no-pager --lines=0 status "$WORKER_SERVICE" || true
    ok "Сервисы перезапущены"
  else
    echo "  ⚠ systemctl не найден — рестартни процессы вручную ($API_SERVICE / $WORKER_SERVICE)"
  fi
else
  echo "  ⏭ рестарт пропущен (--no-restart)"
fi

# ── 6. health-check ──────────────────────────────────────────────────────────
if [ -n "${PLATFORM_PUBLIC_URL:-}" ]; then
  log "Health-check: $HEALTH_URL"
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    ok "API отвечает"
  else
    die "health-check не прошёл — проверь логи: journalctl -u $API_SERVICE -n 50"
  fi
fi

log "Деплой завершён 🚀"
