import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const ADMIN_EMAIL = "playwright@admin.test";
const ADMIN_PASSWORD = "playwright-pw";

async function createAdmin(req: APIRequestContext) {
  await req.post("/__test/reset");
  await req.post("/__test/create-admin", {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
}

/** Login via browser page (sets cookie in page context). */
async function loginPage(page: Page) {
  await page.goto("/admin/login");
  await page.getByTestId("email").fill(ADMIN_EMAIL);
  await page.getByTestId("password").fill(ADMIN_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL("**/admin/chats");
}

async function login(req: APIRequestContext, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  return req.post("/admin/api/login", {
    data: { email, password },
  });
}

test.describe("Admin Login", () => {
  test.beforeEach(async ({ request }) => {
    await createAdmin(request);
  });

  test("shows login form at /admin/login", async ({ page }) => {
    await page.goto("/admin/login");
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.getByTestId("email")).toBeVisible();
    await expect(page.getByTestId("password")).toBeVisible();
  });

  test("wrong credentials shows error", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByTestId("email").fill(ADMIN_EMAIL);
    await page.getByTestId("password").fill("wrong-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });

  test("valid credentials redirects to /admin/chats", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByTestId("email").fill(ADMIN_EMAIL);
    await page.getByTestId("password").fill(ADMIN_PASSWORD);
    await page.getByTestId("login-submit").click();
    await page.waitForURL("**/admin/chats");
    await expect(page).toHaveURL(/\/admin\/chats/);
  });

  test("unauthenticated /admin/chats redirects to login", async ({ page }) => {
    await page.goto("/admin/chats");
    await page.waitForURL("**/admin/login");
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});

test.describe("Admin Users page", () => {
  test.beforeEach(async ({ request }) => {
    await createAdmin(request);
    await request.post("/__test/seed-user", {
      data: { tgUserId: 111, tgUsername: "alice", status: "qualified" },
    });
    await request.post("/__test/seed-user", {
      data: { tgUserId: 222, tgUsername: "bob", status: "new" },
    });
  });

  test("shows users after login", async ({ page }) => {
    await loginPage(page);
    await page.goto("/admin/users");
    await expect(page.getByTestId("users-table")).toBeVisible();
    // user-count is decorated as "— N" in the header; assert it contains
    // the number rather than an exact match so a cosmetic prefix tweak
    // doesn't break this spec.
    await expect(page.getByTestId("user-count")).toContainText("2");
    await expect(page.getByText("@alice")).toBeVisible();
    await expect(page.getByText("@bob")).toBeVisible();
  });
});

test.describe("Admin Chats page", () => {
  test.beforeEach(async ({ request }) => {
    await createAdmin(request);
    await request.post("/__test/seed-user", {
      data: { tgUserId: 300, tgUsername: "charlie" },
    });
    await request.post("/__test/seed-user", {
      data: { tgUserId: 301, tgUsername: "diana" },
    });
    // Trigger a message so conversations get created
    for (const tgId of [300, 301]) {
      await request.post("/telegram/test-secret", {
        data: {
          update_id: tgId,
          message: {
            message_id: tgId,
            from: { id: tgId, is_bot: false, first_name: "X" },
            chat: { id: tgId, type: "private" },
            date: 0,
            text: "hello",
          },
        },
      });
    }
    // Escalate charlie's conversation
    const convRes = await request.get("/admin/api/conversations", {
      headers: { cookie: await adminCookie(request) },
    });
    const { conversations } = (await convRes.json()) as {
      conversations: Array<{ id: number; user: { tg_user_id: number } }>;
    };
    const charlieConv = conversations.find((c) => c.user.tg_user_id === 300);
    if (charlieConv) {
      await request.post(`/admin/api/conversations/${charlieConv.id}/take`, {
        headers: { cookie: await adminCookie(request) },
      });
      // Then put back in queued via a re-seed won't work — instead just verify
      // take works and the badge shows
    }
  });

  test("shows chats list", async ({ page }) => {
    await loginPage(page);
    await page.goto("/admin/chats");
    await expect(page.getByTestId("chats-list")).toBeVisible();
    await expect(page.getByText("@charlie")).toBeVisible();
    await expect(page.getByText("@diana")).toBeVisible();
  });
});

test.describe("Admin Chat detail", () => {
  let convId: number;

  test.beforeEach(async ({ request }) => {
    await createAdmin(request);
    await request.post("/__test/seed-user", {
      data: { tgUserId: 400, tgUsername: "eve" },
    });
    // Create a conversation via webhook
    await request.post("/telegram/test-secret", {
      data: {
        update_id: 400,
        message: {
          message_id: 400,
          from: { id: 400, is_bot: false, first_name: "Eve" },
          chat: { id: 400, type: "private" },
          date: 0,
          text: "hi there",
        },
      },
    });
    const c = await adminCookie(request);
    const convRes = await request.get("/admin/api/conversations", {
      headers: { cookie: c },
    });
    const { conversations } = (await convRes.json()) as {
      conversations: Array<{ id: number; user: { tg_user_id: number } }>;
    };
    convId = conversations.find((x) => x.user.tg_user_id === 400)!.id;
  });

  test("shows messages and take-over button", async ({ page }) => {
    await loginPage(page);
    await page.goto(`/admin/chats/${convId}`);
    await expect(page.getByTestId("messages-list")).toBeVisible();
    await expect(page.getByText("hi there")).toBeVisible();
    await expect(page.getByTestId("take-btn")).toBeVisible();
  });

  test("taking over shows reply box", async ({ page }) => {
    await loginPage(page);
    await page.goto(`/admin/chats/${convId}`);
    await page.getByTestId("take-btn").click();
    await expect(page.getByTestId("reply-input")).toBeVisible();
    await expect(page.getByTestId("release-btn")).toBeVisible();
    // The segmented mode selector replaced the old `mode-badge` element:
    // after take-over the take-btn becomes the active segment AND is
    // disabled (no point clicking what you just turned on). Asserting the
    // disabled state proves take-over actually flipped the conversation
    // mode to "human" — the same invariant the old badge encoded.
    await expect(page.getByTestId("take-btn")).toBeDisabled();
  });

  test("operator sends reply → appears in message list", async ({ page }) => {
    await loginPage(page);
    await page.goto(`/admin/chats/${convId}`);
    // Take over the conversation
    await page.getByTestId("take-btn").click();
    await expect(page.getByTestId("reply-input")).toBeVisible();
    // Type and send reply
    await page.getByTestId("reply-input").fill("Добрый день, помогу!");
    await page.getByTestId("send-btn").click();
    // Message should appear in the messages list (not just the textarea)
    await expect(page.getByTestId("messages-list").getByText("Добрый день, помогу!")).toBeVisible();
    // Input cleared
    await expect(page.getByTestId("reply-input")).toHaveValue("");
  });

  test("release returns conversation to ai mode", async ({ page, request }) => {
    // Take first via API
    const c = await adminCookie(request);
    await request.post(`/admin/api/conversations/${convId}/take`, { headers: { cookie: c } });

    await loginPage(page);
    await page.goto(`/admin/chats/${convId}`);
    await expect(page.getByTestId("release-btn")).toBeVisible();
    await page.getByTestId("release-btn").click();
    // After release: take-btn visible again, reply box gone
    await expect(page.getByTestId("take-btn")).toBeVisible();
    await expect(page.getByTestId("reply-input")).not.toBeVisible();
  });
});

/** Helper: get session cookie value for admin. */
async function adminCookie(req: APIRequestContext): Promise<string> {
  const res = await login(req);
  const headers = res.headers();
  const setCookie = headers["set-cookie"] ?? "";
  return setCookie.split(";")[0] ?? "";
}
