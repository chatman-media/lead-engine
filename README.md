# lead-engine

Монорепо AI-движка продаж: Telegram-бот ведёт лида по воронке, отвечает через
RAG по базе знаний и хранит всё в PostgreSQL.

## Структура

```
apps/
  bot/         Telegram sales-funnel бот (HTTP-сервер, вебхук, админ-API, userbot)
  admin-ui/    React/Vite админ-панель
packages/
  rag/         @chatman-media/rag — RAG-движок (гибридный retrieval, провайдеры LLM)
  sales/       @chatman-media/sales — движок воронки продаж (ELO, A/B, self-play)
  storage/     @chatman-media/storage — Postgres-адаптеры на Drizzle ORM
```

Управляется через bun workspaces. `packages/*` влиты снимком из репозиториев
`chatman-media/{rag,sales,storage}` — см. историю коммитов для исходных SHA.

> **Дублирование:** `apps/bot` содержит собственные `src/rag/` и `src/sales/`,
> которые исторически разошлись с одноимёнными пакетами. Приложение пока
> использует свой код; сведение к пакетам — отдельная задача.

## Команды

```sh
bun install              # установить зависимости всех workspace

bun run dev              # запустить бота (apps/bot, hot-reload)
bun run dev:ui           # запустить админку (apps/admin-ui)
bun run build:ui         # собрать админку

bun run typecheck        # проверка типов бота
bun run check            # biome бота + админки
bun run test             # юнит-тесты бота
bun run test:e2e         # playwright e2e

bun run build:packages   # собрать packages/{rag,sales,storage}
bun run typecheck:packages
bun run test:packages
```

Подробности по боту — в [apps/bot/README.md](apps/bot/README.md).
