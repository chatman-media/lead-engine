# Testing guide

2400+ тестов на Bun (`bun test`). Юнит-тесты бегают без БД; интеграционные —
против реального Postgres с **изоляцией по БД на каждый файл**. Краткая версия
есть в [`../../AGENTS.md`](../../AGENTS.md); здесь — полный разбор.

## Запуск

```bash
# всё (интеграционным нужен Postgres)
DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine bun test

bun test packages/kb                              # один пакет
DATABASE_URL=... bun test apps/api/src/routes/auth.integration.test.ts  # один файл
DATABASE_URL=... bun test --coverage              # покрытие
```

`bun db:up` поднимает Postgres (см. AGENTS.md). Без `DATABASE_URL` или при
недоступном Postgres интеграционные тесты **сами скипаются** (не падают).

## Изоляция БД

`packages/storage/src/integration-helpers.ts`:

| Хелпер | Что делает |
|---|---|
| `tryConnectToPg(url)` | health-check; `null` если БД недоступна → тест скипается |
| `createIsolatedDb({ ownerUrl, testDbName })` | terminate + `DROP IF EXISTS` + `CREATE DATABASE`; возвращает URL свежей БД |
| `applyAllMigrations(sql, migrationsDir)` | прогоняет `migrations/NNNN_*.sql` по порядку |
| `dropIsolatedDb(...)` | очистка в `afterAll` |

`ownerUrl` = `DATABASE_URL` под ролью с правом `CREATE DATABASE` (owner/
superuser). Каждый тест-файл получает **свою** БД — нет общего состояния.

## Паттерн интеграционного теста

Эталон — `apps/api/src/multi-tenant.integration.test.ts`:

```ts
beforeAll(async () => {
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;                                   // skip без БД
  await probe.end();
  const url = await createIsolatedDb({ ownerUrl, testDbName: dbName });
  sql = postgres(url, { onnotice: () => {} });          // тихо
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  // изолированный Hono-app с тем же роутингом, что apps/api/src/index.ts
  app = new Hono();
  app.route("/", makeAuthRoutes({ db, secret: SECRET }));
  app.use("/api/admin/*", makeRequireAuth({ db, secret: SECRET }));
  app.route("/", makeMyFeatureRoutes({ db }));
}, 30_000);

afterAll(async () => { await sql?.end(); });
```

Каждый запрос к tenant-таблицам идёт через `withTenant(db, tenantId, fn)`
(RLS). Тенант сеется прямыми инсертами в setup'е.

## Моки LLM и каналов

- **LLM**: `InMemoryLlmRouter` (`packages/llm-router`) резолвит per-tenant
  клиентов без сети; в тестах конфиги задаются стабами `resolveChat`/
  `resolveEmbed`. Никаких реальных API-вызовов. Пример —
  `apps/api/src/llm-bootstrap.test.ts`.
- **Каналы**: фейковые адаптеры (`FakeTelegramAdapter` и т.п.) реализуют
  `ChannelAdapter` и регистрируются в `ChannelRegistry` — webhook-путь
  прогоняется end-to-end без Telegram/Meta.

## Exchange-фикстуры

`apps/api/src/lib/exchange/tools.workflows.integration.test.ts` гоняет
редактированные диалоговые сценарии (евалы в
`apps/vertical-exchange/evals/`): сеет курсы/тиры/секреты, проигрывает
сообщения через `makeExchangeTools()` и проверяет цепочку tool-call'ов.
Кейсы кандидатов — `apps/vertical-exchange/evals/exchange-candidate-cases/`.

## Что покрыто (ключевое)

- Multi-tenant E2E + RLS-контракт (`packages/storage/src/rls.integration.test.ts` — non-bypass роль).
- SaaS-роуты (auth/KB/LLM/channels/conversations/onboarding/audit/diagnostics).
- RAG-пайплайн (`packages/kb/test/` — MMR/RRF/threshold/multi-query/reranker/cache).
- Exchange (admin rate-card/requisites/orders + tool-loop workflows).
- Rate-limiter, hot-reload (tenant-reloader).

## Частые грабли

См. таблицу «Common pitfalls» в [`../../AGENTS.md`](../../AGENTS.md): запрос вне
`withTenant` (RLS вернёт пусто), `kind`/`source`/`phase` CHECK-констрейнты,
`postgres()` без `onnotice`, reranker без extra-кандидатов.

## Новый тест-файл

`apps/api/src/routes/<feature>.integration.test.ts` по паттерну выше; имя
тест-БД с random-суффиксом; `makeRequireAuth` для admin-роутов; добавить
эндпоинт в API-таблицу [`../../README.md`](../../README.md).
