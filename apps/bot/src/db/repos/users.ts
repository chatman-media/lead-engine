import type { Sql } from "../postgres.ts";

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
  constructor(private sql: Sql) {}

  async byTgId(tgUserId: number): Promise<UserRow | null> {
    const [row] = await this.sql<UserRow[]>`
      SELECT * FROM users WHERE tg_user_id = ${tgUserId} LIMIT 1
    `;
    return row ?? null;
  }

  async byId(id: number): Promise<UserRow | null> {
    const [row] = await this.sql<UserRow[]>`
      SELECT * FROM users WHERE id = ${id} LIMIT 1
    `;
    return row ?? null;
  }

  async create(input: {
    tgUserId: number;
    tgUsername?: string | null;
    status?: UserStatus;
  }): Promise<UserRow> {
    const status: UserStatus = input.status ?? "new";
    // ON CONFLICT against the UNIQUE index on `tg_user_id` makes this safe
    // under concurrent first-message + first-callback (two webhook calls
    // arriving back-to-back used to race here and produce two user rows).
    // DO UPDATE on a sentinel column lets RETURNING fire for the existing
    // row as well; DO NOTHING would skip RETURNING on conflict.
    const [row] = await this.sql<UserRow[]>`
      INSERT INTO users (tg_user_id, tg_username, status)
      VALUES (${input.tgUserId}, ${input.tgUsername ?? null}, ${status})
      ON CONFLICT (tg_user_id) DO UPDATE SET tg_user_id = EXCLUDED.tg_user_id
      RETURNING *
    `;
    if (!row) throw new Error("Failed to create user");
    return row;
  }

  async setStatus(id: number, status: UserStatus): Promise<void> {
    await this.sql`
      UPDATE users SET status = ${status}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  async setProfile(id: number, profile: unknown): Promise<void> {
    await this.sql`
      UPDATE users SET profile_json = ${JSON.stringify(profile)}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  /**
   * Cross-session memory about the candidate (not the bot persona).
   */
  async getMemory(id: number): Promise<UserMemory> {
    const row = await this.byId(id);
    if (!row?.profile_json) return { facts: {} };
    try {
      const parsed = JSON.parse(row.profile_json) as { memory?: UserMemory };
      return parsed.memory ?? { facts: {} };
    } catch {
      return { facts: {} };
    }
  }

  /**
   * Replace stored memory facts wholesale.
   */
  async setMemoryFacts(id: number, facts: Record<string, string>): Promise<void> {
    const row = await this.byId(id);
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
    await this.sql`
      UPDATE users SET profile_json = ${JSON.stringify(parsed)}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  /**
   * Merge new facts into stored memory.
   */
  async mergeMemoryFacts(
    id: number,
    newFacts: Record<string, string>,
    lastExtractedFromMsgId?: number,
  ): Promise<void> {
    const row = await this.byId(id);
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
    await this.sql`
      UPDATE users SET profile_json = ${JSON.stringify(parsed)}, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ${id}
    `;
  }

  async list(limit = 100, offset = 0): Promise<UserRow[]> {
    return this.sql<UserRow[]>`
      SELECT * FROM users ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
  }
}
