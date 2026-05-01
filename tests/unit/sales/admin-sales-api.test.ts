import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { ExperimentsRepo } from "@/db/repos/experiments.ts";
import { seedBuiltinStyles, StylesRepo } from "@/db/repos/styles.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";
import { coldDirectPas } from "@/sales/styles/cold-direct-pas.ts";
import { empatheticNepq } from "@/sales/styles/empathetic-nepq.ts";
import { flirtyBelfort } from "@/sales/styles/flirty-belfort.ts";
import { TelegramClient, type FetchLike } from "@/telegram/client.ts";

const SECRET = "s";

function setup() {
  const db = openDb({ path: ":memory:" });
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  const telegram = new TelegramClient({ token: "t", fetch: fetchImpl });
  const router = createRouter({ db, telegram, webhookSecret: SECRET });
  const server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });
  return { db, server };
}

/** Seed the 3 builtin styles into a freshly-opened DB. Keep this OUT of
 *  beforeEach to mirror admin-api.test.ts setup (which apparently has the
 *  exact CPU budget for the bcrypt hash + login fetch and nothing else). */
function seedStyles(db: ReturnType<typeof openDb>) {
  seedBuiltinStyles(new StylesRepo(db), [
    flirtyBelfort,
    empatheticNepq,
    coldDirectPas,
  ]);
}

function teardown(s: { db: ReturnType<typeof openDb>; server: Server }) {
  s.server.stop(true);
  s.db.close();
}

let ctx: ReturnType<typeof setup>;
let cookie: string;

// 30s ceiling on hooks — bcrypt cost-12 hash + login fetch + Bun.serve port
// allocation can together exceed Bun's default 5s when the host is under
// any concurrent load (other test files, IDE indexing, build processes).
// Real work in here is sub-200ms; this is just an honest slack budget.
beforeEach(async () => {
  ctx = setup();
  const admins = new AdminsRepo(ctx.db);
  await admins.create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${ctx.server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  const set = login.headers.get("set-cookie")!;
  cookie = set.split(";")[0]!;
}, 30_000);
afterEach(() => teardown(ctx));

function url(path: string) {
  return `http://127.0.0.1:${ctx.server.port}${path}`;
}
function authed(extra: RequestInit = {}): RequestInit {
  return { ...extra, headers: { ...(extra.headers ?? {}), cookie } };
}

describe("GET /admin/api/styles", () => {
  test("requires auth", async () => {
    const res = await fetch(url("/admin/api/styles"));
    expect(res.status).toBe(401);
  });

  test("returns the 3 seeded styles", async () => {
    seedStyles(ctx.db);
    const res = await fetch(url("/admin/api/styles"), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      styles: Array<{ slug: string; display_name: string; is_active: boolean }>;
    };
    expect(body.styles.length).toBe(3);
    const slugs = body.styles.map((s) => s.slug).sort();
    expect(slugs).toEqual(
      ["cold-direct-pas-v1", "empathetic-nepq-v1", "flirty-belfort-v1"].sort(),
    );
    expect(body.styles.every((s) => s.is_active)).toBe(true);
  });

  test("excludes soft-deleted styles", async () => {
    seedStyles(ctx.db);
    const repo = new StylesRepo(ctx.db);
    repo.deactivate(repo.bySlug("cold-direct-pas-v1")!.id);
    const res = await fetch(url("/admin/api/styles"), authed());
    const body = (await res.json()) as { styles: Array<{ slug: string }> };
    expect(body.styles.map((s) => s.slug)).not.toContain("cold-direct-pas-v1");
  });
});

describe("GET /admin/api/styles/:id", () => {
  test("returns the parsed config", async () => {
    seedStyles(ctx.db);
    const repo = new StylesRepo(ctx.db);
    const row = repo.bySlug("flirty-belfort-v1")!;
    const res = await fetch(url(`/admin/api/styles/${row.id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      style: { slug: string; config: { persona: { name: string } } | null; parse_error: string | null };
    };
    expect(body.style.slug).toBe("flirty-belfort-v1");
    expect(body.style.parse_error).toBeNull();
    expect(body.style.config?.persona.name).toBe(flirtyBelfort.persona.name);
  });

  test("malformed config_json surfaces parse_error but doesn't crash", async () => {
    ctx.db.run(
      `INSERT INTO styles (slug, display_name, config_json) VALUES (?, ?, ?)`,
      ["broken", "Broken", "{not json"],
    );
    const id = (
      ctx.db
        .query<{ id: number }, [string]>(
          "SELECT id FROM styles WHERE slug = ?",
        )
        .get("broken")
    )!.id;
    const res = await fetch(url(`/admin/api/styles/${id}`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      style: { config: unknown; parse_error: string | null };
    };
    expect(body.style.config).toBeNull();
    expect(body.style.parse_error).not.toBeNull();
  });

  test("404 for unknown id", async () => {
    const res = await fetch(url("/admin/api/styles/9999"), authed());
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/api/experiments", () => {
  test("creates a draft and returns 201", async () => {
    seedStyles(ctx.db);
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "my-test",
          allocation: { "flirty-belfort-v1": 50, "empathetic-nepq-v1": 50 },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      experiment: { slug: string; status: string; allocation: Record<string, number> };
    };
    expect(body.experiment.slug).toBe("my-test");
    expect(body.experiment.status).toBe("draft");
    expect(body.experiment.allocation).toEqual({
      "flirty-belfort-v1": 50,
      "empathetic-nepq-v1": 50,
    });
  });

  test("rejects allocation referencing missing style", async () => {
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "ghost-ref",
          allocation: { "does-not-exist": 100 },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does-not-exist");
  });

  test("rejects empty allocation", async () => {
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "empty", allocation: {} }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects negative weight", async () => {
    seedStyles(ctx.db);
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "neg",
          allocation: { "flirty-belfort-v1": -1 },
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects non-kebab-case slug", async () => {
    seedStyles(ctx.db);
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "Bad_Slug",
          allocation: { "flirty-belfort-v1": 100 },
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("conflict on duplicate slug", async () => {
    seedStyles(ctx.db);
    const create = () =>
      fetch(
        url("/admin/api/experiments"),
        authed({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug: "dup",
            allocation: { "flirty-belfort-v1": 100 },
          }),
        }),
      );
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
  });

  test("refuses to create another running experiment when one is already live", async () => {
    seedStyles(ctx.db);
    new ExperimentsRepo(ctx.db).insert({
      slug: "live",
      status: "running",
      allocation: { "flirty-belfort-v1": 100 },
      startedAt: 1,
    });
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "second",
          status: "running",
          allocation: { "flirty-belfort-v1": 100 },
        }),
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /admin/api/experiments/:id", () => {
  // All tests here need a baseline style for the allocation references.
  beforeEach(() => seedStyles(ctx.db));

  async function createDraft(slug = "x") {
    const res = await fetch(
      url("/admin/api/experiments"),
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          allocation: { "flirty-belfort-v1": 100 },
        }),
      }),
    );
    return ((await res.json()) as { experiment: { id: number } }).experiment.id;
  }

  test("status=running stamps started_at", async () => {
    const id = await createDraft("a");
    const res = await fetch(
      url(`/admin/api/experiments/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      experiment: { status: string; started_at: number | null };
    };
    expect(body.experiment.status).toBe("running");
    expect(body.experiment.started_at).not.toBeNull();
  });

  test("rejects invalid status", async () => {
    const id = await createDraft("b");
    const res = await fetch(
      url(`/admin/api/experiments/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "garbage" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("refuses to start a second running experiment", async () => {
    const liveId = await createDraft("a");
    const otherId = await createDraft("b");
    await fetch(
      url(`/admin/api/experiments/${liveId}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    const res = await fetch(
      url(`/admin/api/experiments/${otherId}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  test("422 when trying to start an experiment with malformed allocation_json", async () => {
    ctx.db.run(
      `INSERT INTO experiments (slug, status, allocation_json, success_metric)
       VALUES ('broken', 'draft', '{not json', 'qualified')`,
    );
    const id = (
      ctx.db
        .query<{ id: number }, [string]>("SELECT id FROM experiments WHERE slug = ?")
        .get("broken")
    )!.id;
    const res = await fetch(
      url(`/admin/api/experiments/${id}`),
      authed({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("GET /admin/api/experiments/:id/funnel", () => {
  beforeEach(() => seedStyles(ctx.db));

  test("returns per-style funnel rows", async () => {
    const exp = new ExperimentsRepo(ctx.db).insert({
      slug: "f",
      status: "running",
      allocation: {
        "flirty-belfort-v1": 50,
        "empathetic-nepq-v1": 50,
      },
      startedAt: 1,
    });

    // Add a couple of conversations bound to one style.
    const styles = new StylesRepo(ctx.db);
    const flirtyId = styles.bySlug("flirty-belfort-v1")!.id;
    const users = new UsersRepo(ctx.db);
    const u1 = users.create({ tgUserId: 1, status: "qualified" });
    const u2 = users.create({ tgUserId: 2, status: "new" });
    const conversations = new ConversationsRepo(ctx.db);
    const c1 = conversations.ensureForUser(u1.id);
    const c2 = conversations.ensureForUser(u2.id);
    conversations.assignStyle(c1.id, flirtyId, exp.id);
    conversations.assignStyle(c2.id, flirtyId, exp.id);

    const res = await fetch(url(`/admin/api/experiments/${exp.id}/funnel`), authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      funnel: Array<{
        slug: string;
        conversations: number;
        qualified: number;
        pending: number;
      }>;
    };
    const flirty = body.funnel.find((r) => r.slug === "flirty-belfort-v1")!;
    expect(flirty.conversations).toBe(2);
    expect(flirty.qualified).toBe(1);
    expect(flirty.pending).toBe(1);
  });

  test("404 for unknown id", async () => {
    const res = await fetch(url("/admin/api/experiments/9999/funnel"), authed());
    expect(res.status).toBe(404);
  });
});
