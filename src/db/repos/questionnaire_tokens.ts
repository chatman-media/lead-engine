import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export interface QuestionnaireTokenRow {
  token: string;
  user_id: number;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export class QuestionnaireTokensRepo {
  constructor(private db: Database) {}

  issue(userId: number, opts: { ttlSeconds?: number } = {}): string {
    const token = generateToken();
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    this.db.run(`INSERT INTO questionnaire_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`, [
      token,
      userId,
      expiresAt,
    ]);
    return token;
  }

  getValid(token: string): QuestionnaireTokenRow | null {
    const row = this.db
      .query<QuestionnaireTokenRow, [string]>(
        `SELECT * FROM questionnaire_tokens
         WHERE token = ? AND used_at IS NULL AND expires_at > unixepoch()
         LIMIT 1`,
      )
      .get(token);
    return row ?? null;
  }

  /** Marks the token used and returns the user_id, or null if invalid/used. */
  consume(token: string): number | null {
    const row = this.getValid(token);
    if (!row) return null;
    this.db.run(`UPDATE questionnaire_tokens SET used_at = unixepoch() WHERE token = ?`, [token]);
    return row.user_id;
  }
}
