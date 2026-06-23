/**
 * DrizzleKbStore — Postgres+pgvector реализация IKbStore: ingest (upsert doc /
 * insert chunk / dedup-lookup / delete) + поиск (vector / BM25 / hybrid /
 * priority). Требует DATABASE_URL (+ pgvector); без него — graceful-skip.
 */
import type { IKbStore, KbScope, KbSearchHit } from "@chatman-media/kb";
import {
  applyAllMigrations,
  createIsolatedDb,
  schema,
  tryConnectToPg,
} from "@chatman-media/storage";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { DrizzleKbStore, ScopedKbStore } from "./kb-store.ts";

const ownerUrl = process.env.DATABASE_URL;
const dbName = `lead_engine_kbstore_${Math.random().toString(36).slice(2, 10)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "storage",
  "migrations",
);

let sql: Sql | null = null;
let db: PostgresJsDatabase<typeof schema>;
let enabled = false;
let n = 0;
let tenantId = 0;
let store: DrizzleKbStore;

/** 1536-dim unit vector with a single 1 at `pos` — даёт детерминированную близость. */
function vec(pos: number): number[] {
  const v = new Array(1536).fill(0);
  v[pos] = 1;
  return v;
}

function scopeKey(scope?: KbScope | null): string {
  if (!scope) return "none";
  return `${scope.scopeType}:${scope.funnelId ?? ""}:${scope.stageSlug ?? ""}`;
}

function hit(text: string): KbSearchHit {
  return {
    chunk_id: 1,
    distance: 0,
    text,
    document_id: 1,
    source: "fake",
    title: "Fake",
  };
}

class FakeKbStore implements IKbStore {
  calls: string[] = [];
  hits = new Map<string, KbSearchHit[]>();

  async search(
    _embedding: number[],
    _k: number,
    _topic?: string | null,
    scope?: KbScope | null,
  ): Promise<KbSearchHit[]> {
    this.calls.push(scopeKey(scope));
    return this.hits.get(scopeKey(scope)) ?? [];
  }

  async hybridSearch(): Promise<KbSearchHit[]> {
    return [];
  }

  async prioritySearch(): Promise<KbSearchHit[]> {
    return [];
  }

  async getDocumentBySource() {
    return null;
  }

  async countChunksForDocument() {
    return 0;
  }

  async deleteDocument() {
    return false;
  }

  async upsertDocument() {
    return { id: 1 };
  }

  async insertChunkWithEmbedding() {}
}

beforeAll(async () => {
  if (!ownerUrl) return;
  const probe = await tryConnectToPg(ownerUrl);
  if (!probe) return;
  await probe.end({ timeout: 0 }).catch(() => {});
  sql = postgres(await createIsolatedDb({ ownerUrl, testDbName: dbName }), {
    max: 3,
    onnotice: () => {},
  });
  await applyAllMigrations(sql, migrationsDir);
  db = drizzle(sql, { schema });
  enabled = true;
  n = Math.floor(Date.now() / 1000);
  const [t] = await db
    .insert(schema.tenants)
    .values({ slug: `kbstore-${n}` })
    .returning({ id: schema.tenants.id });
  tenantId = t!.id;
  store = new DrizzleKbStore({ db, tenantId });
}, 30_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 0 }).catch(() => {});
}, 10_000);

describe("ScopedKbStore", () => {
  it("search uses stage docs before broader scopes", async () => {
    const inner = new FakeKbStore();
    const stageHits = [hit("stage doc")];
    inner.hits.set("stage:7:payment", stageHits);
    inner.hits.set("funnel:7:", [hit("funnel doc")]);
    inner.hits.set("global::", [hit("global doc")]);

    const store = new ScopedKbStore(inner, {
      scopeType: "stage",
      funnelId: 7,
      stageSlug: "payment",
    });

    expect(await store.search(vec(0), 5)).toBe(stageHits);
    expect(inner.calls).toEqual(["stage:7:payment"]);
  });

  it("search falls back stage -> funnel -> global", async () => {
    const inner = new FakeKbStore();
    const globalHits = [hit("global doc")];
    inner.hits.set("global::", globalHits);

    const store = new ScopedKbStore(inner, {
      scopeType: "stage",
      funnelId: 7,
      stageSlug: "payment",
    });

    expect(await store.search(vec(0), 5)).toBe(globalHits);
    expect(inner.calls).toEqual(["stage:7:payment", "funnel:7:", "global::"]);
  });
});

// ── ScopedKbStore: hybrid/priority + делегирование ingest-методов (без БД) ──

/** Богатый фейк: пишет search-вызовы с topic и hybrid-вызовы со scope. */
class RecordingKbStore implements IKbStore {
  searchCalls: Array<{ topic: string | null | undefined; scope: string }> = [];
  hybridCalls: string[] = [];
  /** key: `${topic ?? ""}|${scopeKey}` */
  searchHits = new Map<string, KbSearchHit[]>();
  hybridHits = new Map<string, KbSearchHit[]>();
  delegated: string[] = [];

  async search(
    _embedding: number[],
    _k: number,
    topic?: string | null,
    scope?: KbScope | null,
  ): Promise<KbSearchHit[]> {
    const key = `${topic ?? ""}|${scopeKey(scope ?? null)}`;
    this.searchCalls.push({ topic, scope: scopeKey(scope ?? null) });
    return this.searchHits.get(key) ?? [];
  }

  async hybridSearch(input: {
    embedding: number[];
    query: string;
    k?: number;
    topic?: string | null;
    scope?: KbScope | null;
  }): Promise<KbSearchHit[]> {
    this.hybridCalls.push(scopeKey(input.scope ?? null));
    return this.hybridHits.get(scopeKey(input.scope ?? null)) ?? [];
  }

  async prioritySearch(): Promise<KbSearchHit[]> {
    return [];
  }

  async getDocumentBySource(source: string) {
    this.delegated.push(`doc:${source}`);
    return { id: 5, content_hash: "h" };
  }

  async countChunksForDocument(documentId: number) {
    this.delegated.push(`count:${documentId}`);
    return 3;
  }

  async deleteDocument(id: number) {
    this.delegated.push(`del:${id}`);
    return true;
  }

  async upsertDocument(input: { source: string }) {
    this.delegated.push(`upsert:${input.source}`);
    return { id: 8 };
  }

  async insertChunkWithEmbedding(input: { chunkIndex: number }) {
    this.delegated.push(`chunk:${input.chunkIndex}`);
  }
}

describe("ScopedKbStore — hybrid/priority/delegates", () => {
  const stageScope: KbScope = {
    scopeType: "stage",
    funnelId: 7,
    stageSlug: "payment",
  };

  it("hybridSearch falls back stage -> funnel -> global", async () => {
    const inner = new RecordingKbStore();
    const globalHits = [hit("global doc")];
    inner.hybridHits.set("global::", globalHits);

    const store = new ScopedKbStore(inner, stageScope);
    const res = await store.hybridSearch({
      embedding: vec(0),
      query: "курс",
      k: 5,
    });

    expect(res).toBe(globalHits);
    expect(inner.hybridCalls).toEqual(["stage:7:payment", "funnel:7:", "global::"]);
  });

  it("hybridSearch: funnel-scope чейн funnel -> global", async () => {
    const inner = new RecordingKbStore();
    const funnelHits = [hit("funnel doc")];
    inner.hybridHits.set("funnel:7:", funnelHits);

    const store = new ScopedKbStore(inner, {
      scopeType: "funnel",
      funnelId: 7,
    });

    expect(await store.hybridSearch({ embedding: vec(0), query: "q" })).toBe(funnelHits);
    expect(inner.hybridCalls).toEqual(["funnel:7:"]);
  });

  it("prioritySearch: books-хиты возвращаются сразу (без hybrid)", async () => {
    const inner = new RecordingKbStore();
    const bookHits = [hit("book doc")];
    inner.searchHits.set("books|stage:7:payment", bookHits);

    const store = new ScopedKbStore(inner, stageScope);
    const res = await store.prioritySearch({
      embedding: vec(0),
      query: "книга",
    });

    expect(res).toBe(bookHits);
    expect(inner.hybridCalls).toEqual([]);
    expect(inner.searchCalls[0]).toEqual({
      topic: "books",
      scope: "stage:7:payment",
    });
  });

  it("prioritySearch vectorOnly: без books → чистый vector fallback", async () => {
    const inner = new RecordingKbStore();
    const vectorHits = [hit("vector doc")];
    inner.searchHits.set("|global::", vectorHits);

    const store = new ScopedKbStore(inner, null);
    const res = await store.prioritySearch({
      embedding: vec(0),
      query: "q",
      vectorOnly: true,
    });

    expect(res).toBe(vectorHits);
    expect(inner.hybridCalls).toEqual([]);
  });

  it("prioritySearch default: без books → hybrid fallback", async () => {
    const inner = new RecordingKbStore();
    const hybridHits = [hit("hybrid doc")];
    inner.hybridHits.set("global::", hybridHits);

    const store = new ScopedKbStore(inner, { scopeType: "global" });
    const res = await store.prioritySearch({ embedding: vec(0), query: "q" });

    expect(res).toBe(hybridHits);
    expect(inner.hybridCalls).toEqual(["global::"]);
  });

  it("ingest-методы делегируются внутреннему store как есть", async () => {
    const inner = new RecordingKbStore();
    const store = new ScopedKbStore(inner, stageScope);

    expect(await store.getDocumentBySource("src.md")).toEqual({
      id: 5,
      content_hash: "h",
    });
    expect(await store.countChunksForDocument(5)).toBe(3);
    expect(await store.deleteDocument(5)).toBe(true);
    expect(
      await store.upsertDocument({
        source: "src.md",
        title: "t",
        contentHash: "h2",
      }),
    ).toEqual({ id: 8 });
    await store.insertChunkWithEmbedding({
      documentId: 8,
      chunkIndex: 0,
      text: "x",
      tokenCount: 1,
      embedding: null,
    });

    expect(inner.delegated).toEqual(["doc:src.md", "count:5", "del:5", "upsert:src.md", "chunk:0"]);
  });
});

describe("DrizzleKbStore — ingest", () => {
  it("upsertDocument → id, getDocumentBySource находит, dedup на (source,hash)", async () => {
    if (!enabled) return;
    const doc = await store.upsertDocument({
      source: "inline:doc1",
      title: "Курс обмена",
      contentHash: "hash1",
    });
    expect(doc.id).toBeGreaterThan(0);
    const found = await store.getDocumentBySource("inline:doc1");
    expect(found?.id).toBe(doc.id);
    expect(found?.content_hash).toBe("hash1");
    // upsert того же (source,hash) → тот же id
    const again = await store.upsertDocument({
      source: "inline:doc1",
      title: "Курс обмена",
      contentHash: "hash1",
    });
    expect(again.id).toBe(doc.id);
  });

  it("getDocumentBySource для несуществующего → null", async () => {
    if (!enabled) return;
    expect(await store.getDocumentBySource("inline:nope")).toBeNull();
  });

  it("insertChunkWithEmbedding + countChunksForDocument", async () => {
    if (!enabled) return;
    const doc = await store.upsertDocument({
      source: "inline:doc2",
      title: "Условия",
      contentHash: "hash2",
      topic: "exchange",
    });
    await store.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "USDT меняем по курсу 36.5 бат",
      tokenCount: 10,
      embedding: vec(0),
    });
    await store.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 1,
      text: "Минимальная сумма обмена 100 долларов",
      tokenCount: 8,
      embedding: vec(1),
    });
    expect(await store.countChunksForDocument(doc.id)).toBe(2);
  });

  it("deleteDocument удаляет doc + chunks → true", async () => {
    if (!enabled) return;
    const doc = await store.upsertDocument({
      source: "inline:todelete",
      title: "Temp",
      contentHash: "hashdel",
    });
    await store.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "временный чанк",
      tokenCount: 3,
      embedding: vec(5),
    });
    expect(await store.deleteDocument(doc.id)).toBe(true);
    expect(await store.countChunksForDocument(doc.id)).toBe(0);
    expect(await store.getDocumentBySource("inline:todelete")).toBeNull();
  });
});

describe("DrizzleKbStore — search", () => {
  it("vector search: ближайший чанк по embedding первым", async () => {
    if (!enabled) return;
    const hits = await store.search(vec(0), 5);
    expect(hits.length).toBeGreaterThan(0);
    // vec(0) точно совпадает с первым чанком doc2 → distance ~0
    expect(hits[0]!.text).toContain("USDT");
    expect(hits[0]!.distance).toBeLessThan(0.01);
  });

  it("vector search c topic-фильтром (over-fetch + post-filter)", async () => {
    if (!enabled) return;
    const hits = await store.search(vec(0), 5, "exchange");
    // все чанки относятся к doc2 (topic=exchange) или NULL-topic
    expect(hits.length).toBeGreaterThan(0);
  });

  it("textSearch (BM25) по слову из чанка", async () => {
    if (!enabled) return;
    const hits = await store.textSearch("курсу", 5);
    expect(Array.isArray(hits)).toBe(true);
  });

  it("textSearch находит text-only chunk без embedding", async () => {
    if (!enabled) return;
    const doc = await store.upsertDocument({
      source: "inline:text-only",
      title: "Text-only rules",
      contentHash: "hash-text-only",
    });
    await store.insertChunkWithEmbedding({
      documentId: doc.id,
      chunkIndex: 0,
      text: "Текстовый поиск должен находить документ без embedding vector",
      tokenCount: 8,
      embedding: null,
    });

    const textHits = await store.textSearch("текстовый", 5);
    expect(textHits.some((hit) => hit.document_id === doc.id)).toBe(true);

    const vectorHits = await store.search(vec(0), 20);
    expect(vectorHits.some((hit) => hit.document_id === doc.id)).toBe(false);
  });

  it("textSearch пустой/мусорный query → []", async () => {
    if (!enabled) return;
    expect(await store.textSearch("   ", 5)).toEqual([]);
  });

  it("hybridSearch объединяет vector + BM25", async () => {
    if (!enabled) return;
    const hits = await store.hybridSearch({ embedding: vec(0), query: "USDT курс", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("prioritySearch без books-чанков → global fallback (hybrid)", async () => {
    if (!enabled) return;
    const hits = await store.prioritySearch({ embedding: vec(0), query: "обмен", k: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("prioritySearch vectorOnly fallback", async () => {
    if (!enabled) return;
    const hits = await store.prioritySearch({
      embedding: vec(0),
      query: "обмен",
      k: 5,
      vectorOnly: true,
    });
    expect(hits.length).toBeGreaterThan(0);
  });
});
