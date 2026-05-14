import { randomBytes } from "node:crypto";
import type { Sql } from "../postgres.ts";

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
  constructor(private sql: Sql) {}

  async issue(userId: number, opts: { ttlSeconds?: number } = {}): Promise<string> {
    const token = generateToken();
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    await this.sql`
      INSERT INTO questionnaire_tokens (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expiresAt})
    `;
    return token;
  }

  async getValid(token: string): Promise<QuestionnaireTokenRow | null> {
    const [row] = await this.sql<QuestionnaireTokenRow[]>`
      SELECT * FROM questionnaire_tokens
      WHERE token = ${token} AND used_at IS NULL AND expires_at > EXTRACT(EPOCH FROM NOW())::INTEGER
      LIMIT 1
    `;
    return row ?? null;
  }

  async consume(token: string): Promise<number | null> {
    const row = await this.getValid(token);
    if (!row) return null;
    await this.sql`
      UPDATE questionnaire_tokens SET used_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE token = ${token}
    `;
    return row.user_id;
  }
}
