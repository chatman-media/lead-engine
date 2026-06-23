import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e для admin-ui (SPA) — браузерный смоук критичного фронт-флоу
 * (логин → онбординг-гейт). Поднимает изолированный стек сам:
 *   - apps/api на E2E_API_PORT против отдельной БД lead_engine_e2e
 *     (ALLOW_PUBLIC_SIGNUP=1, throwaway master key, фоновые поллеры выключены);
 *   - admin-ui vite на E2E_UI_PORT с proxy /api → apps/api (same-origin: у api нет CORS).
 *
 * БД готовит pretest-скрипт `e2e/setup-db.ts` (см. package.json "test:e2e"):
 *   bun run e2e/setup-db.ts && playwright test
 * Сидинг логина (signup e2e@demo.io) делает globalSetup ПОСЛЕ старта api.
 *
 * Требует: запущенный Postgres на :5434 (bun db:up) и установленный браузер
 * (`bunx playwright install chromium`).
 */

const API_PORT = Number(process.env.E2E_API_PORT ?? 3210);
const UI_PORT = Number(process.env.E2E_UI_PORT ?? 4210);
const PG_HOST = process.env.E2E_PG ?? "postgres://lead:lead@localhost:5434";
const DB_NAME = process.env.E2E_DB_NAME ?? "lead_engine_e2e";
const DATABASE_URL = `${PG_HOST}/${DB_NAME}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun run src/index.ts",
      cwd: "../api",
      url: `http://localhost:${API_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        DATABASE_URL,
        PLATFORM_MASTER_KEY: "0".repeat(64),
        TELEGRAM_WEBHOOK_SECRET: "e2e",
        PORT: String(API_PORT),
        ALLOW_PUBLIC_SIGNUP: "1",
        // Глушим фоновые поллеры/фид — e2e не про них, лишний шум/сеть ни к чему.
        RATE_FEED_MS: "0",
        OUTREACH_DRIP_MS: "0",
        AUTO_CLOSE_MS: "0",
        REPLY_DEBOUNCE_MS: "0",
      },
    },
    {
      command: `bun run dev -- --port ${UI_PORT} --strictPort`,
      url: `http://localhost:${UI_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { E2E_API_PROXY: `http://localhost:${API_PORT}` },
    },
  ],
});
