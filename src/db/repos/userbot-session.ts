import type { Sql } from "../postgres.ts";

export async function loadUserbotSession(sql: Sql): Promise<string> {
  const [row] = await sql<{ session_string: string }[]>`
    SELECT session_string FROM userbot_session WHERE id = 1
  `;
  return row?.session_string ?? "";
}

export async function saveUserbotSession(sql: Sql, sessionString: string): Promise<void> {
  await sql`
    INSERT INTO userbot_session (id, session_string)
    VALUES (1, ${sessionString})
    ON CONFLICT (id) DO UPDATE SET session_string = EXCLUDED.session_string, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER
  `;
}
