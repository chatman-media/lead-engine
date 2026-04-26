import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationsRepo } from "@/db/repos/conversations.ts";
import { KbRepo } from "@/db/repos/kb.ts";
import { MessagesRepo } from "@/db/repos/messages.ts";
import { UsersRepo } from "@/db/repos/users.ts";
import { openDb } from "@/db/sqlite.ts";

let tmpDir: string;
let dbPath: string;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tg-bot-db-"));
  dbPath = join(tmpDir, "test.db");
  db = openDb({ path: dbPath });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrations", () => {
  test("applies all .sql files and is idempotent", () => {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      )
      .all()
      .map((r) => r.name);

    for (const t of [
      "_migrations",
      "admins",
      "conversations",
      "kb_chunks",
      "kb_documents",
      "messages",
      "questionnaire_tokens",
      "sessions",
      "users",
    ]) {
      expect(tables).toContain(t);
    }

    const vecTables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name LIKE 'kb_vec%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(vecTables.length).toBeGreaterThan(0);
  });
});

describe("users repo", () => {
  test("create / lookup / status update", () => {
    const repo = new UsersRepo(db);
    const created = repo.create({ tgUserId: 100, tgUsername: "alice" });
    expect(created.tg_user_id).toBe(100);
    expect(created.status).toBe("new");

    const found = repo.byTgId(100);
    expect(found?.id).toBe(created.id);

    repo.setStatus(created.id, "qualified");
    expect(repo.byId(created.id)?.status).toBe("qualified");
  });
});

describe("conversations + messages", () => {
  test("ensureForUser is idempotent and messages persist", () => {
    const users = new UsersRepo(db);
    const convs = new ConversationsRepo(db);
    const msgs = new MessagesRepo(db);

    const u = users.create({ tgUserId: 200 });
    const c1 = convs.ensureForUser(u.id);
    const c2 = convs.ensureForUser(u.id);
    expect(c1.id).toBe(c2.id);
    expect(c1.mode).toBe("ai");

    msgs.add({ conversationId: c1.id, role: "user", text: "hello" });
    msgs.add({ conversationId: c1.id, role: "assistant", text: "hi!" });
    const list = msgs.listByConversation(c1.id);
    expect(list.map((m) => m.text)).toEqual(["hello", "hi!"]);

    convs.setMode(c1.id, "queued");
    expect(convs.byId(c1.id)?.mode).toBe("queued");
    convs.setMode(c1.id, "human", 42);
    expect(convs.byId(c1.id)?.mode).toBe("human");
    expect(convs.byId(c1.id)?.assigned_admin_id).toBe(42);
    convs.setMode(c1.id, "ai");
    expect(convs.byId(c1.id)?.mode).toBe("ai");
    expect(convs.byId(c1.id)?.assigned_admin_id).toBeNull();
  });
});

describe("kb_vec KNN with sqlite-vec", () => {
  test("nearest-neighbour search returns chunks ordered by distance", () => {
    const kb = new KbRepo(db);
    const doc = kb.upsertDocument({
      source: "test://doc",
      title: "test",
      contentHash: "h1",
    });

    const dim = 1536;
    function vec(seed: number): number[] {
      const arr = new Array<number>(dim);
      for (let i = 0; i < dim; i++) arr[i] = i === seed ? 1 : 0;
      return arr;
    }

    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "vector at 0",
      tokenCount: 1,
      embedding: vec(0),
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 1,
      text: "vector at 5",
      tokenCount: 1,
      embedding: vec(5),
    });
    kb.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 2,
      text: "vector at 10",
      tokenCount: 1,
      embedding: vec(10),
    });

    const hits = kb.search(vec(5), 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.text).toBe("vector at 5");
    expect(hits[0]!.distance).toBeLessThanOrEqual(hits[1]!.distance);
  });
});
