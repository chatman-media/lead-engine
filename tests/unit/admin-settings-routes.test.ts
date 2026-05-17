import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

import { createRouter } from "@/app.ts";
import { AdminsRepo } from "@/db/repos/admins.ts";
import { TelegramClient } from "@/telegram/client.ts";
import { cleanTestDb, getTestSql, setupTestDb } from "../helpers/test-db.ts";

const SECRET = "s";
// Point the settings route at a throwaway file so it never touches the
// project's real .env.
const ENV_FILE = join(tmpdir(), `tg-settings-test-${process.pid}-${Date.now()}.env`);
// Keys the runtime-settings route may write — cleared between tests so a
// PUT mirroring into process.env doesn't leak into the next test's GET.
const TOUCHED_ENV_KEYS = [
  "RAG_REFLECT",
  "RAG_USER_MEMORY",
  "RAG_QUERY_REWRITE",
  "RAG_HYBRID_SEARCH",
  "RAG_CONVERSATION_SUMMARY",
  "RAG_TOPIC_ROUTING",
  "RAG_CHAT_TEMPERATURE",
  "VISION_ENABLED",
  "OPENAI_CHAT_MODEL",
  "OPENROUTER_CHAT_MODEL",
  "OLLAMA_CHAT_MODEL",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
];

function clearTouchedEnv() {
  for (const k of TOUCHED_ENV_KEYS) delete process.env[k];
  if (existsSync(ENV_FILE)) rmSync(ENV_FILE);
}

const sql = getTestSql();
beforeAll(() => {
  process.env.ADMIN_SETTINGS_ENV_FILE = ENV_FILE;
  return setupTestDb(sql);
});
afterEach(() => {
  clearTouchedEnv();
  return cleanTestDb(sql);
});
afterAll(async () => {
  delete process.env.ADMIN_SETTINGS_ENV_FILE;
  clearTouchedEnv();
  await sql.end();
});

let server: Server;
let cookie: string;

beforeEach(async () => {
  const telegram = new TelegramClient({
    token: "t",
    fetch: async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
  });
  const router = createRouter({ sql, telegram, webhookSecret: SECRET });
  server = Bun.serve({ port: 0, fetch: (req) => router.handle(req) });

  await new AdminsRepo(sql).create({ email: "op@x.test", password: "longenough" });
  const login = await fetch(`http://127.0.0.1:${server.port}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "op@x.test", password: "longenough" }),
  });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 30_000);

afterEach(() => server.stop(true));

function url(path: string) {
  return `http://127.0.0.1:${server.port}${path}`;
}

describe("runtime settings routes", () => {
  test("GET requires admin auth", async () => {
    const res = await fetch(url("/admin/api/settings/runtime"));
    expect(res.status).toBe(401);
  });

  test("GET returns the chat model and the RAG feature toggles", async () => {
    const res = await fetch(url("/admin/api/settings/runtime"), { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      env_path: string;
      provider: string;
      settings: Array<{ key: string; type: string; value: string }>;
    };
    const keys = body.settings.map((s) => s.key);
    // Exactly one chat-model key (provider-dependent) + the seven tunables.
    expect(keys).toContain("RAG_REFLECT");
    expect(keys).toContain("RAG_CHAT_TEMPERATURE");
    expect(keys.some((k) => k.endsWith("_CHAT_MODEL"))).toBe(true);
    expect(body.settings.find((s) => s.key === "RAG_REFLECT")?.type).toBe("boolean");
  });

  test("PUT writes settings to the .env file and mirrors them into process.env", async () => {
    const res = await fetch(url("/admin/api/settings/runtime"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { RAG_REFLECT: true, RAG_CHAT_TEMPERATURE: 0.7 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; restart_required: boolean };
    expect(body.ok).toBe(true);
    expect(body.restart_required).toBe(true);

    // Persisted to the .env file…
    const written = readFileSync(ENV_FILE, "utf8");
    expect(written).toContain("RAG_REFLECT=1");
    expect(written).toContain("RAG_CHAT_TEMPERATURE=0.7");
    // …and mirrored into the live process so a re-GET is consistent.
    expect(process.env.RAG_REFLECT).toBe("1");

    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::INTEGER AS n FROM audit_log WHERE action = 'settings.runtime.update'
    `;
    expect(row!.n).toBe(1);
  });

  test("PUT preserves unrelated lines already in the .env file", async () => {
    await Bun.write(ENV_FILE, "TELEGRAM_BOT_TOKEN=keepme\nRAG_REFLECT=0\n");
    const res = await fetch(url("/admin/api/settings/runtime"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { RAG_REFLECT: true } }),
    });
    expect(res.status).toBe(200);
    const written = readFileSync(ENV_FILE, "utf8");
    expect(written).toContain("TELEGRAM_BOT_TOKEN=keepme");
    expect(written).toContain("RAG_REFLECT=1");
    // The stale RAG_REFLECT=0 line is replaced, not duplicated.
    expect(written.match(/^RAG_REFLECT=/gm)?.length).toBe(1);
  });

  test("PUT rejects an unknown / non-whitelisted key", async () => {
    // DATABASE_URL is deliberately NOT editable from the UI.
    const res = await fetch(url("/admin/api/settings/runtime"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { DATABASE_URL: "postgres://leak" } }),
    });
    expect(res.status).toBe(400);
  });

  test("PUT rejects an out-of-range temperature", async () => {
    const res = await fetch(url("/admin/api/settings/runtime"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { RAG_CHAT_TEMPERATURE: 9 } }),
    });
    expect(res.status).toBe(400);
  });

  test("GET masks secrets — never returns the raw key value", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-supersecret-9999";
    const res = await fetch(url("/admin/api/settings/runtime"), { headers: { cookie } });
    const body = (await res.json()) as {
      settings: Array<{
        key: string;
        secret?: boolean;
        value: string;
        configured?: boolean;
        preview?: string;
      }>;
    };
    const orKey = body.settings.find((s) => s.key === "OPENROUTER_API_KEY");
    expect(orKey?.secret).toBe(true);
    expect(orKey?.configured).toBe(true);
    expect(orKey?.value).toBe(""); // raw value never leaves the server
    expect(orKey?.preview).toBe("••••9999");
    expect(JSON.stringify(body)).not.toContain("supersecret");
  });

  test("PUT writes a non-empty secret to the .env file", async () => {
    const res = await fetch(url("/admin/api/settings/runtime"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ updates: { OPENROUTER_API_KEY: "sk-or-new-key-0001" } }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(ENV_FILE, "utf8")).toContain("OPENROUTER_API_KEY=sk-or-new-key-0001");
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-new-key-0001");
  });

  test("PUT with an empty secret keeps the existing key (does not wipe it)", async () => {
    await Bun.write(ENV_FILE, "OPENROUTER_API_KEY=sk-or-existing-key\n");
    const res = await fetch(url("/admin/api/settings/runtime"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      // Empty secret is skipped; the real setting still applies.
      body: JSON.stringify({ updates: { OPENROUTER_API_KEY: "", RAG_REFLECT: true } }),
    });
    expect(res.status).toBe(200);
    const written = readFileSync(ENV_FILE, "utf8");
    expect(written).toContain("OPENROUTER_API_KEY=sk-or-existing-key");
    expect(written).toContain("RAG_REFLECT=1");
  });
});
