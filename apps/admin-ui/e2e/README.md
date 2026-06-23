# admin-ui e2e (Playwright)

Браузерный смоук критичного фронт-флоу: логин-страница рендерится, неавторизованный
заход редиректит на `/login`, логин свежего тенанта ведёт на онбординг-гейт. Ловит
«белый экран»/краши рантайма, которые бэкенд-тесты не видят.

## Запуск

Нужен поднятый Postgres на `:5434` (`bun db:up`) и один раз — браузер:

```bash
cd apps/admin-ui
bun run e2e:install        # playwright install chromium (один раз)
bun run test:e2e           # setup-db → поднять стек → прогнать спеки
bun run test:e2e:headed    # то же, но с видимым браузером
```

`test:e2e` сам:
1. пересоздаёт+мигрирует изолированную БД `lead_engine_e2e`
   (`apps/api/scripts/e2e-setup-db.ts` — в бэкенд-контексте, где резолвится
   `@chatman-media/storage`);
2. поднимает `apps/api` (порт `E2E_API_PORT`=3210, `ALLOW_PUBLIC_SIGNUP=1`,
   throwaway master key, фоновые поллеры выключены) и `vite` (порт `E2E_UI_PORT`=4210)
   через Playwright `webServer`; vite проксирует `/api` → apps/api по `E2E_API_PROXY`
   (у apps/api нет CORS — нужен same-origin);
3. сидит логин `e2e@demo.io` через реальный `/api/auth/signup` (globalSetup);
4. гоняет `e2e/*.e2e.ts` в chromium.

## Env-оверрайды

`E2E_API_PORT`, `E2E_UI_PORT`, `E2E_PG` (`postgres://lead:lead@localhost:5434`),
`E2E_DB_NAME` (`lead_engine_e2e`). Дефолты подходят для локалки.

## CI

В CI нужны: сервис Postgres на `:5434`, `bunx playwright install --with-deps chromium`,
затем `bun run --cwd apps/admin-ui test:e2e`. `reuseExistingServer` выключается при `CI=1`.
