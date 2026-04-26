import { expect, test } from "@playwright/test";

const TG_USER_ID = 7777001;

test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
  await request.post("/__test/seed-user", {
    data: { tgUserId: TG_USER_ID, status: "questionnaire_pending" },
  });
});

test("user opens link, submits valid form, status flips to qualified", async ({
  page,
  request,
}) => {
  const issued = await request.post("/__test/issue-token", {
    data: { tgUserId: TG_USER_ID },
  });
  expect(issued.ok()).toBeTruthy();
  const { token } = (await issued.json()) as { token: string };

  await page.goto(`/q/${token}`);
  await expect(page.locator("h1")).toContainText("Расскажите о себе");

  await page.fill('input[name="name"]', "Alice");
  await page.fill('input[name="email"]', "alice@example.test");
  await page.fill('textarea[name="goal"]', "I want to buy your product.");
  await page.click('button[type="submit"]');

  await expect(page.locator("#success")).toBeVisible();

  const userRes = await request.get(`/__test/user/${TG_USER_ID}`);
  expect(userRes.ok()).toBeTruthy();
  const user = await userRes.json();
  expect(user.status).toBe("qualified");
  const profile = JSON.parse(user.profile_json);
  expect(profile).toMatchObject({
    name: "Alice",
    email: "alice@example.test",
    goal: "I want to buy your product.",
  });
});

test("invalid email shows inline error and does not consume token", async ({
  page,
  request,
}) => {
  const issued = await request.post("/__test/issue-token", {
    data: { tgUserId: TG_USER_ID },
  });
  const { token } = (await issued.json()) as { token: string };

  await page.goto(`/q/${token}`);
  await page.fill('input[name="name"]', "Bob");
  await page.fill('input[name="email"]', "totally-not-an-email");
  await page.fill('textarea[name="goal"]', "test");
  await page.click('button[type="submit"]');

  await expect(page.locator(".error")).toContainText(/email/i);

  await page.goto(`/q/${token}`);
  await expect(page.locator("h1")).toContainText("Расскажите о себе");
});

test("expired/unknown token shows 404 page", async ({ page }) => {
  const res = await page.goto(`/q/never-existed`);
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toContainText("недействительна");
});
