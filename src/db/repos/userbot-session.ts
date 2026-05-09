import type { Database } from "bun:sqlite";

export function loadUserbotSession(db: Database): string {
  const row = db
    .query<{ session_string: string }, []>(
      "SELECT session_string FROM userbot_session WHERE id = 1",
    )
    .get();
  return row?.session_string ?? "";
}

export function saveUserbotSession(db: Database, sessionString: string): void {
  db.run(
    `INSERT INTO userbot_session (id, session_string, updated_at)
     VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET session_string = excluded.session_string, updated_at = excluded.updated_at`,
    [sessionString],
  );
}
