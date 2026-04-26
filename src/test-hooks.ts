/**
 * Routes mounted only when TEST_HOOKS=1. Used by Playwright to seed data into
 * the running server's DB without a separate admin/CLI dance. NOT mounted in
 * production.
 */
import type { Database } from "bun:sqlite";

import { AdminsRepo } from "./db/repos/admins.ts";
import { ConversationsRepo } from "./db/repos/conversations.ts";
import { QuestionnaireTokensRepo } from "./db/repos/questionnaire_tokens.ts";
import { UsersRepo } from "./db/repos/users.ts";
import { json, Router } from "./router.ts";

export function mountTestHooks(router: Router, db: Database): void {
  const admins = new AdminsRepo(db);
  const users = new UsersRepo(db);
  const tokens = new QuestionnaireTokensRepo(db);
  const conversations = new ConversationsRepo(db);

  router.post("/__test/reset", () => {
    db.exec("DELETE FROM messages");
    db.exec("DELETE FROM conversations");
    db.exec("DELETE FROM questionnaire_tokens");
    db.exec("DELETE FROM users");
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM admins");
    return json({ ok: true });
  });

  router.post("/__test/create-admin", async ({ req }) => {
    const body = (await req.json()) as { email: string; password: string };
    const existing = admins.byEmail(body.email);
    if (existing) return json({ id: existing.id });
    const a = await admins.create({
      email: body.email,
      password: body.password,
    });
    return json({ id: a.id });
  });

  router.post("/__test/seed-user", async ({ req }) => {
    const body = (await req.json()) as {
      tgUserId: number;
      tgUsername?: string;
      status?:
        | "new"
        | "questionnaire_pending"
        | "qualified"
        | "won"
        | "lost";
    };
    const existing = users.byTgId(body.tgUserId);
    const u =
      existing ??
      users.create({
        tgUserId: body.tgUserId,
        tgUsername: body.tgUsername ?? null,
        status: body.status,
      });
    if (existing && body.status) {
      users.setStatus(existing.id, body.status);
    }
    conversations.ensureForUser(u.id);
    return json({ id: u.id });
  });

  router.post("/__test/issue-token", async ({ req }) => {
    const body = (await req.json()) as { tgUserId: number };
    const u = users.byTgId(body.tgUserId);
    if (!u) return json({ error: "no such user" }, { status: 404 });
    const token = tokens.issue(u.id);
    return json({ token });
  });

  router.get("/__test/user/:tgUserId", ({ params }) => {
    const u = users.byTgId(Number(params.tgUserId));
    if (!u) return json({ error: "not found" }, { status: 404 });
    return json(u);
  });
}
