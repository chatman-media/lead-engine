/**
 * ConversationsRepo — CRUD + inbox-метаданные (unread / status / assignee /
 * summary) + tenant-изоляция. Требует DATABASE_URL; без него — graceful-skip.
 */
import { applyAllMigrations, createIsolatedDb, schema, tryConnectToPg } from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { ConversationsRepo } from "./conversations.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_conv_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "storage", "migrations");

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let t1 = 0;
let t2 = 0;
let contact1 = 0;

const repo = () => new ConversationsRepo({ db, tenantId: t1 });

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), { max: 3, onnotice: () => {} });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);
  const [a] = await db.insert(schema.tenants).values({ slug: `conv-a-${n}` }).returning({ id: schema.tenants.id });
  const [b] = await db.insert(schema.tenants).values({ slug: `conv-b-${n}` }).returning({ id: schema.tenants.id });
  t1 = a!.id;
  t2 = b!.id;
  const [c] = await db
    .insert(schema.contacts)
    .values({ tenantId: t1, displayName: "Conv Contact", createdAt: n })
    .returning({ id: schema.contacts.id });
  contact1 = c!.id;
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

// Свежий контакт под каждый тест: UNIQUE (tenant, user, source) + source-check
// (bot|userbot|self_play) не дают переиспользовать один контакт многократно.
async function freshContact(): Promise<number> {
  const [c] = await db
    .insert(schema.contacts)
    .values({ tenantId: t1, displayName: `c-${Math.random().toString(36).slice(2, 8)}`, createdAt: n })
    .returning({ id: schema.contacts.id });
  return c!.id;
}

describe("ConversationsRepo", () => {
  it("create → строка с дефолтами; findById находит; чужой tenant — нет", async () => {
    if (!enabled) return;
    const conv = await repo().create({ contactId: contact1, source: "bot", nowEpoch: n });
    expect(conv.id).toBeGreaterThan(0);
    expect(conv.source).toBe("bot");
    expect((await repo().findById(conv.id))?.id).toBe(conv.id);
    // изоляция
    expect(await new ConversationsRepo({ db, tenantId: t2 }).findById(conv.id)).toBeNull();
  });

  it("create c mode/styleId/experimentId", async () => {
    if (!enabled) return;
    const conv = await repo().create({
      contactId: await freshContact(),
      source: "userbot",
      mode: "human",
      styleId: null,
      experimentId: null,
      nowEpoch: n,
    });
    expect(conv.mode).toBe("human");
  });

  it("findByContactAndSource", async () => {
    if (!enabled) return;
    const found = await repo().findByContactAndSource(contact1, "bot");
    expect(found?.source).toBe("bot");
    expect(await repo().findByContactAndSource(contact1, "self_play")).toBeNull();
  });

  it("touchLastMessageAt обновляет таймстамп", async () => {
    if (!enabled) return;
    const conv = await repo().create({ contactId: await freshContact(), source: "bot", nowEpoch: n });
    await repo().touchLastMessageAt(conv.id, n + 500);
    expect((await repo().findById(conv.id))?.lastMessageAt).toBe(n + 500);
  });

  it("updateInboxMetadata: text + status + incrementUnread", async () => {
    if (!enabled) return;
    const conv = await repo().create({ contactId: await freshContact(), source: "bot", nowEpoch: n });
    await repo().updateInboxMetadata(conv.id, {
      lastMessageText: "привет",
      lastMessageAt: n + 10,
      status: "pending",
      incrementUnread: true,
    });
    await repo().updateInboxMetadata(conv.id, { incrementUnread: true });
    const row = await repo().findById(conv.id);
    expect(row?.lastMessageText).toBe("привет");
    expect(row?.status).toBe("pending");
    expect(row?.unreadCount).toBe(2);
  });

  it("markAsRead обнуляет unreadCount", async () => {
    if (!enabled) return;
    const conv = await repo().create({ contactId: await freshContact(), source: "bot", nowEpoch: n });
    await repo().updateInboxMetadata(conv.id, { incrementUnread: true });
    await repo().markAsRead(conv.id);
    expect((await repo().findById(conv.id))?.unreadCount).toBe(0);
  });

  it("setAssignee / setSummaryJson", async () => {
    if (!enabled) return;
    const conv = await repo().create({ contactId: await freshContact(), source: "bot", nowEpoch: n });
    await repo().setAssignee(conv.id, 42);
    await repo().setSummaryJson(conv.id, '{"summary":"x"}');
    const row = await repo().findById(conv.id);
    expect(row?.assignedAdminId).toBe(42);
    expect(row?.summaryJson).toBe('{"summary":"x"}');
    // снять ассайн
    await repo().setAssignee(conv.id, null);
    expect((await repo().findById(conv.id))?.assignedAdminId).toBeNull();
  });

  it("recent → DESC by last_message_at, ограничено limit", async () => {
    if (!enabled) return;
    const rows = await repo().recent(3);
    expect(rows.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i]!.lastMessageAt ?? 0;
      const b = rows[i + 1]!.lastMessageAt ?? 0;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });
});
