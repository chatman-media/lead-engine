import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error("DATABASE_URL env var is required — set it to your PostgreSQL connection string");

export const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

export type Sql = typeof sql;
