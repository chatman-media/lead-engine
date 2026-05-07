import type { Database } from "bun:sqlite";

export type UserStatus = "new" | "questionnaire_pending" | "qualified" | "won" | "lost";

export interface UserRow {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  status: UserStatus;
  profile_json: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Cross-session memory stored inside `users.profile_json.memory`.
 * `facts` keys are flexible — typical: "city", "age", "name", "intent",
 * "experience", "language", "country_target". `lastExtractedFromMsgId` lets
 * the extractor skip messages it has already seen.
 */
export interface UserMemory {
  facts: Record<string, string>;
  lastExtractedFromMsgId?: number;
  updatedAt?: number;
}

export class UsersRepo {
  constructor(private db: Database) {}

  byTgId(tgUserId: number): UserRow | null {
    return (
      this.db
        .query<UserRow, [number]>("SELECT * FROM users WHERE tg_user_id = ? LIMIT 1")
        .get(tgUserId) ?? null
    );
  }

  byId(id: number): UserRow | null {
    return (
      this.db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ? LIMIT 1").get(id) ?? null
    );
  }

  create(input: { tgUserId: number; tgUsername?: string | null; status?: UserStatus }): UserRow {
    const status: UserStatus = input.status ?? "new";
    const row = this.db
      .query<UserRow, [number, string | null, UserStatus]>(
        `INSERT INTO users (tg_user_id, tg_username, status)
         VALUES (?, ?, ?)
         RETURNING *`,
      )
      .get(input.tgUserId, input.tgUsername ?? null, status);
    if (!row) throw new Error("Failed to create user");
    return row;
  }

  setStatus(id: number, status: UserStatus): void {
    this.db.run("UPDATE users SET status = ?, updated_at = unixepoch() WHERE id = ?", [status, id]);
  }

  setProfile(id: number, profile: unknown): void {
    this.db.run("UPDATE users SET profile_json = ?, updated_at = unixepoch() WHERE id = ?", [
      JSON.stringify(profile),
      id,
    ]);
  }

  /**
   * Cross-session memory about the candidate (not the bot persona).
   * Persisted under `profile_json.memory.facts` so it survives conversation
   * resets. Keys are LLM-extracted attributes ("city", "age", "intent", etc).
   */
  getMemory(id: number): UserMemory {
    const row = this.byId(id);
    if (!row?.profile_json) return { facts: {} };
    try {
      const parsed = JSON.parse(row.profile_json) as { memory?: UserMemory };
      return parsed.memory ?? { facts: {} };
    } catch {
      return { facts: {} };
    }
  }

  /**
   * Replace stored memory facts wholesale. Used by the admin UI when an
   * operator manually edits the memory pane — operator edits are
   * authoritative (they often correct extractor mistakes), so we don't
   * merge, we replace. Empty/whitespace values are dropped.
   */
  setMemoryFacts(id: number, facts: Record<string, string>): void {
    const row = this.byId(id);
    if (!row) return;

    let parsed: { memory?: UserMemory } & Record<string, unknown> = {};
    if (row.profile_json) {
      try {
        parsed = JSON.parse(row.profile_json);
      } catch {
        parsed = {};
      }
    }
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(facts)) {
      const trimmedKey = k.trim();
      const trimmedVal = (v ?? "").trim();
      if (!trimmedKey || !trimmedVal) continue;
      cleaned[trimmedKey] = trimmedVal;
    }
    const prev = parsed.memory ?? { facts: {} };
    parsed.memory = {
      facts: cleaned,
      ...(prev.lastExtractedFromMsgId !== undefined
        ? { lastExtractedFromMsgId: prev.lastExtractedFromMsgId }
        : {}),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.db.run("UPDATE users SET profile_json = ?, updated_at = unixepoch() WHERE id = ?", [
      JSON.stringify(parsed),
      id,
    ]);
  }

  /**
   * Merge new facts into stored memory. New keys overwrite old ones (latest
   * wins). Empty / whitespace values clear the key. Atomic via single UPDATE.
   */
  mergeMemoryFacts(
    id: number,
    newFacts: Record<string, string>,
    lastExtractedFromMsgId?: number,
  ): void {
    const row = this.byId(id);
    if (!row) return;

    let parsed: { memory?: UserMemory } & Record<string, unknown> = {};
    if (row.profile_json) {
      try {
        parsed = JSON.parse(row.profile_json);
      } catch {
        parsed = {};
      }
    }
    const prev = parsed.memory ?? { facts: {} };
    const mergedFacts: Record<string, string> = { ...prev.facts };
    for (const [k, v] of Object.entries(newFacts)) {
      const trimmed = (v ?? "").trim();
      if (trimmed) mergedFacts[k] = trimmed;
      else delete mergedFacts[k];
    }
    const memory: UserMemory = {
      facts: mergedFacts,
      ...(lastExtractedFromMsgId !== undefined ? { lastExtractedFromMsgId } : {}),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    parsed.memory = memory;
    this.db.run("UPDATE users SET profile_json = ?, updated_at = unixepoch() WHERE id = ?", [
      JSON.stringify(parsed),
      id,
    ]);
  }

  list(limit = 100, offset = 0): UserRow[] {
    return this.db
      .query<UserRow, [number, number]>(
        "SELECT * FROM users ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
  }
}
