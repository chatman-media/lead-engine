import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:process";
import * as sqliteVec from "sqlite-vec";

import { activeEmbeddingDim, config } from "../config.ts";
import { ensureKbVec } from "./ensure-kb-vec.ts";
import { runMigrations } from "./migrate.ts";

let _db: Database | null = null;
let customSqliteSet = false;

function ensureCustomSqlite() {
  if (customSqliteSet) return;
  if (platform === "darwin") {
    const candidates = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ];
    for (const path of candidates) {
      if (existsSync(path)) {
        try {
          Database.setCustomSQLite(path);
        } catch {
          // Already loaded on hot-reload — safe to ignore.
        }
        customSqliteSet = true;
        return;
      }
    }
    throw new Error(
      "Could not find a SQLite build with extension support on macOS. " +
        "Install via `brew install sqlite` or set DB_PATH to point to a usable build.",
    );
  }
  customSqliteSet = true;
}

export type DbOptions = {
  path?: string;
  runMigrations?: boolean;
  /** Override the active embedding dimension (defaults to current LLM provider config). */
  embeddingDim?: number;
};

export function openDb(opts: DbOptions = {}): Database {
  const path = opts.path ?? config.dbPath;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  ensureCustomSqlite();
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  sqliteVec.load(db);
  if (opts.runMigrations !== false) {
    runMigrations(db);
  }
  ensureKbVec(db, opts.embeddingDim ?? activeEmbeddingDim());
  return db;
}

export function getDb(): Database {
  if (!_db) {
    _db = openDb();
  }
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Encode a JS number array as the binary blob sqlite-vec expects. */
export function encodeVector(values: ArrayLike<number>): Uint8Array {
  const arr = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) arr[i] = values[i] as number;
  return new Uint8Array(arr.buffer);
}
