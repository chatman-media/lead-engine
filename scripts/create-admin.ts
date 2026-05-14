#!/usr/bin/env bun
import { sql } from "../src/db/postgres.ts";
import { AdminsRepo } from "../src/db/repos/admins.ts";

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  if (!email || !password) {
    console.error("Usage: bun scripts/create-admin.ts <email> <password>");
    process.exit(1);
  }
  const admins = new AdminsRepo(sql);
  const existing = await admins.byEmail(email);
  if (existing) {
    console.error(`Admin already exists: ${existing.email} (id=${existing.id})`);
    process.exit(1);
  }
  const a = await admins.create({ email, password });
  console.log(`Created admin id=${a.id} email=${a.email}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
