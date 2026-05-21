import * as schema from "@chatman-media/storage";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function makeDb(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    // worker — long-running, может крутить несколько circular workflows
    // (dispatcher + receive-loops + cron). 20 — комфортный потолок для
    // первых 50 tenants.
    max: 20,
    prepare: false,
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
