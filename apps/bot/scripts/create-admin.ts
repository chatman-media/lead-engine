#!/usr/bin/env bun
import { sql } from "../src/db/postgres.ts";
import { type AdminRole, AdminsRepo, isAdminRole } from "../src/db/repos/admins.ts";

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const roleArg = process.argv[4] ?? "superadmin";
  if (!email || !password) {
    console.error("Usage: bun scripts/create-admin.ts <email> <password> [superadmin|manager]");
    console.error("  role defaults to superadmin");
    process.exit(1);
  }
  if (!isAdminRole(roleArg)) {
    console.error(`Invalid role "${roleArg}" — expected "superadmin" or "manager"`);
    process.exit(1);
  }
  const role: AdminRole = roleArg;
  const admins = new AdminsRepo(sql);
  const existing = await admins.byEmail(email);
  if (existing) {
    console.error(`Admin already exists: ${existing.email} (id=${existing.id})`);
    process.exit(1);
  }
  const a = await admins.create({ email, password, role });
  console.log(`Created admin id=${a.id} email=${a.email} role=${a.role}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
