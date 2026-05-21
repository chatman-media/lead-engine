# apps/bot — DEPRECATED

Эта директория — копия [chatman-media/sales-guru](https://github.com/chatman-media/sales-guru),
которую исходно скопировали в монорепо `lead-engine` как entrypoint single-tenant'ной
архитектуры. После re-design'а (PR #2) функциональность перенесена в:

- **HTTP webhook + RAG/LLM-loop** → `apps/api`
- **Outbound dispatcher + cron** → `apps/worker`
- **RAG-pipeline** → потребляется через `@chatman-media/rag` (нет копии)
- **Sales-engine + styles** → потребляется через `@chatman-media/sales` + `apps/vertical-recruitment-uae/src/styles/`
- **Telegram BotAPI + MTProto** → `@chatman-media/channel-telegram`
- **Conversation pipeline (contact/conv/msg/lead-lifecycle)** → `@chatman-media/conversation-engine`
- **Vertical-specific (intake/visa)** → `apps/vertical-recruitment-uae`

## Текущий статус

- **Удалён из bun workspaces** в корневом `package.json` — не build'ится,
  не trigger'ит CI, не подтягивает deps. Файлы оставлены для consult'а
  оператором (verbatim промпт-фрагменты, edge-case fix'ы, и т.д.).
- **Будет удалён полностью** (`git rm -rf apps/bot/`) в отдельном PR после
  стабильного периода работы `apps/api` + `apps/worker` в проде.

## Если нужно посмотреть код

Файлы доступны через git history либо в зеркале sales-guru:
https://github.com/chatman-media/sales-guru

См. [Issue #3](https://github.com/chatman-media/lead-engine/issues/3),
блок C — финальное удаление.
