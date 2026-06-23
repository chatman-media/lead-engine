import { request } from "@playwright/test";

/**
 * Сидит известный логин ПОСЛЕ старта apps/api (webServer уже поднят) — через
 * реальный signup-эндпоинт (ALLOW_PUBLIC_SIGNUP=1). Первый админ тенанта
 * становится superadmin → после логина OnboardingGate ведёт на /onboarding.
 * 409 (уже есть) — ок: БД могла не сброситься между прогонами.
 */
export default async function globalSetup() {
  const apiPort = process.env.E2E_API_PORT ?? "3210";
  const ctx = await request.newContext({ baseURL: `http://localhost:${apiPort}` });
  const res = await ctx.post("/api/auth/signup", {
    data: { email: "e2e@demo.io", password: "test1234e2e" },
  });
  const status = res.status();
  if (![200, 201, 409].includes(status)) {
    throw new Error(`[e2e] seed signup failed: ${status} ${await res.text()}`);
  }
  await ctx.dispose();
}
