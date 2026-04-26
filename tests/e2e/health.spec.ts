import { expect, test } from "@playwright/test";

test("health endpoint returns 200 and 'ok' body", async ({ page, request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/html");

  await page.goto("/health");
  await expect(page.locator("#health")).toHaveText("ok");
});
