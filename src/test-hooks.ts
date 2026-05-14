/**
 * Routes mounted only when TEST_HOOKS=1. Used by Playwright to seed data into
 * the running server's DB without a separate admin/CLI dance. NOT mounted in
 * production.
 */
import type { Sql } from "./db/postgres.ts";

import { AdminsRepo } from "./db/repos/admins.ts";
import { ConversationsRepo } from "./db/repos/conversations.ts";
import { type LeadState, LeadsRepo } from "./db/repos/leads.ts";
import { QuestionnaireTokensRepo } from "./db/repos/questionnaire_tokens.ts";
import { UsersRepo } from "./db/repos/users.ts";
import { json, type Router } from "./router.ts";

export function mountTestHooks(router: Router, sql: Sql): void {
  const admins = new AdminsRepo(sql);
  const users = new UsersRepo(sql);
  const tokens = new QuestionnaireTokensRepo(sql);
  const conversations = new ConversationsRepo(sql);
  const leads = new LeadsRepo(sql);

  router.post("/__test/reset", async () => {
    // Order matters: child rows first to satisfy FK constraints.
    await sql`DELETE FROM lead_notes`;
    await sql`DELETE FROM lead_events`;
    await sql`DELETE FROM leads`;
    await sql`DELETE FROM messages`;
    await sql`DELETE FROM conversations`;
    await sql`DELETE FROM questionnaire_tokens`;
    await sql`DELETE FROM users`;
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM admins`;
    return json({ ok: true });
  });

  router.post("/__test/create-admin", async ({ req }) => {
    const body = (await req.json()) as { email: string; password: string };
    const existing = await admins.byEmail(body.email);
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
      status?: "new" | "questionnaire_pending" | "qualified" | "won" | "lost";
    };
    const existing = await users.byTgId(body.tgUserId);
    const u =
      existing ??
      (await users.create({
        tgUserId: body.tgUserId,
        tgUsername: body.tgUsername ?? null,
        status: body.status,
      }));
    if (existing && body.status) {
      await users.setStatus(existing.id, body.status);
    }
    await conversations.ensureForUser(u.id);
    return json({ id: u.id });
  });

  router.post("/__test/issue-token", async ({ req }) => {
    const body = (await req.json()) as { tgUserId: number };
    const u = await users.byTgId(body.tgUserId);
    if (!u) return json({ error: "no such user" }, { status: 404 });
    const token = await tokens.issue(u.id);
    return json({ token });
  });

  router.get("/__test/user/:tgUserId", async ({ params }) => {
    const u = await users.byTgId(Number(params.tgUserId));
    if (!u) return json({ error: "not found" }, { status: 404 });
    return json(u);
  });

  /**
   * Seed a lead at a given state for the user identified by `tgUserId`.
   * Used by Playwright to bypass the intake-collection LLM dance and
   * exercise the operator-side pipeline directly.
   */
  router.post("/__test/seed-lead", async ({ req }) => {
    const body = (await req.json()) as {
      tgUserId: number;
      state?: LeadState;
    };
    const u = await users.byTgId(body.tgUserId);
    if (!u) return json({ error: "no such user" }, { status: 404 });
    const lead = await leads.ensureForUser(u.id);
    if (body.state && body.state !== lead.state) {
      const updated = await leads.setState(lead.id, body.state);
      return json({ id: updated?.id ?? lead.id, state: updated?.state ?? lead.state });
    }
    return json({ id: lead.id, state: lead.state });
  });

  /** Inspect the current lead row for a user — for assertions. */
  router.get("/__test/lead/:tgUserId", async ({ params }) => {
    const u = await users.byTgId(Number(params.tgUserId));
    if (!u) return json({ error: "no user" }, { status: 404 });
    const lead = await leads.byUserId(u.id);
    if (!lead) return json({ error: "no lead" }, { status: 404 });
    return json(lead);
  });
}
