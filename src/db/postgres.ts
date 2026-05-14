import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL env var is required — set it to your PostgreSQL connection string");

// BIGINT columns in this schema hold Telegram IDs (tg_user_id, ops_chat_id) which
// fit comfortably in Number.MAX_SAFE_INTEGER. postgres.js defaults bigints to string
// to avoid precision loss; we override so row types match repo declarations (number).
export const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (x: number | bigint) => String(x),
      parse: (x: string) => Number(x),
    },
  },
});

export type Sql = typeof sql;
