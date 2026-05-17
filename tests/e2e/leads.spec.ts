import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const ADMIN_EMAIL = "playwright@admin.test";
const ADMIN_PASSWORD = "playwright-pw";

async function reset(req: APIRequestContext) {
  await req.post("/__test/reset");
  await req.post("/__test/create-admin", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
}

async function loginPage(page: Page) {
  await page.goto("/admin/login");
  await page.getByTestId("email").fill(ADMIN_EMAIL);
  await page.getByTestId("password").fill(ADMIN_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL("**/admin");
}

async function seedLeadAtState(req: APIRequestContext, tgUserId: number, state: string) {
  await req.post("/__test/seed-user", {
    data: { tgUserId, tgUsername: `user${tgUserId}` },
  });
  await req.post("/__test/seed-lead", {
    data: { tgUserId, state },
  });
}

async function getLeadFromApi(req: APIRequestContext, tgUserId: number) {
  const r = await req.get(`/__test/lead/${tgUserId}`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()) as { id: number; state: string; application_id: string | null };
}

test.describe("Lead pipeline e2e", () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test("intake_complete lead appears on /admin/leads, approve transitions to docs_pending", async ({
    page,
    request,
  }) => {
    await seedLeadAtState(request, 7001, "intake_complete");
    await loginPage(page);
    await page.goto("/admin/leads");

    // Lead card visible.
    const card = page.getByTestId("lead-card").first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("user7001");

    // Approve via UI — no confirm dialog on this action (see Leads.tsx).
    await card.getByTestId("lead-approve").click();

    // After approve, the API state is docs_pending. Verify via test hook
    // (UI may filter the card out of the visible list depending on the
    // page's state filter — server-side state is the source of truth).
    await expect
      .poll(async () => (await getLeadFromApi(request, 7001)).state, { timeout: 5000 })
      .toBe("docs_pending");
  });

  test("reject path sets state=rejected with the reason", async ({ page, request }) => {
    await seedLeadAtState(request, 7002, "intake_complete");
    await loginPage(page);
    await page.goto("/admin/leads");

    const card = page.getByTestId("lead-card").first();
    await expect(card).toBeVisible();

    // Reject prompts for a reason — Playwright's prompt dialog handler.
    page.once("dialog", (d) => d.accept("не подходит по возрасту"));
    await card.getByTestId("lead-reject").click();

    await expect
      .poll(async () => (await getLeadFromApi(request, 7002)).state, { timeout: 5000 })
      .toBe("rejected");
  });

  test("submit-to-visa allocates VS-YYYY-NNNN application_id", async ({ page, request }) => {
    // docs_complete lead has visa-docs filled and is one click from submission.
    await seedLeadAtState(request, 7003, "docs_complete");
    await loginPage(page);
    await page.goto("/admin/leads");

    const card = page.getByTestId("lead-card").first();
    await expect(card).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await card.getByTestId("lead-submit-visa").click();

    await expect
      .poll(async () => (await getLeadFromApi(request, 7003)).application_id, { timeout: 5000 })
      .toMatch(/^VS-\d{4}-\d+$/);
  });
});
