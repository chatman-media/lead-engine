CREATE TABLE IF NOT EXISTS userbot_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_string TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO userbot_session (id, session_string) VALUES (1, '');
