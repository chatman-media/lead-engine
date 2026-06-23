import { expect, type Page, test } from "@playwright/test";

// Ловим uncaught-исключения страницы — это «белый экран»/краш рантайма, который
// бэкенд-тесты не видят. Возвращаем массив, который тест проверяет на пустоту.
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("логин-страница рендерится без краша", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "С возвращением" })).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Войти" })).toBeVisible();
  expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
});

test("неавторизованный заход на /dashboard → редирект на /login", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "С возвращением" })).toBeVisible();
});

test("логин свежего тенанта → онбординг-гейт рендерится", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto("/login");
  await page.fill("#email", "e2e@demo.io");
  await page.fill("#password", "test1234e2e");
  await page.getByRole("button", { name: "Войти" }).click();

  // Свежий superadmin без завершённого онбординга → OnboardingGate ведёт на /onboarding.
  await expect(page.getByRole("heading", { name: "Настройка кабинета" })).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding/);

  // Токен сессии сохранён в localStorage.
  const token = await page.evaluate(() => localStorage.getItem("lead_engine_token"));
  expect(token).toBeTruthy();

  // Рендер прошёл без uncaught-исключений (нет «белого экрана»).
  expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
});
