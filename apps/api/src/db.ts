import * as schema from "@chatman-media/storage";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/** Singleton drizzle БД для apps/api process'а. */
export function makeDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    // max=10 — apps/api это HTTP-frontend, не должен расходовать пул.
    // Тяжёлые long-running запросы крутятся в apps/worker (max=20).
    max: 10,
    prepare: false,
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
