import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

export const sql = postgres(url, {
  ssl: "require",
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

export type Sql = typeof sql;
