/**
 * Удаляет существующий аккаунт по email и создаёт новый tenant + admin.
 * Запуск: DATABASE_URL=<prod-url> PLATFORM_PUBLIC_URL=<url> bun run apps/api/scripts/recreate-account.ts
 */

import { adminInvites, admins, conversations, leads, tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const EMAIL = "ak.chatman.media@gmail.com";
const NEW_PASSWORD = "changeme123"; // временный, сменить после входа
const ADMIN_UI_BASE_URL = process.env.PLATFORM_PUBLIC_URL ?? "https://client.exchanges.agency";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const client = postgres(DATABASE_URL);
const db = drizzle(client);

async function main() {
  // 1. Найти существующего admin
  const [existing] = await db
    .select({ id: admins.id, tenantId: admins.tenantId, email: admins.email, role: admins.role })
    .from(admins)
    .where(eq(admins.email, EMAIL));

  if (existing) {
    console.log(
      `Найден admin: id=${existing.id}, tenantId=${existing.tenantId}, role=${existing.role}`,
    );

    // Удаляем инвайты тенанта
    const deletedInvites = await db
      .delete(adminInvites)
      .where(eq(adminInvites.tenantId, existing.tenantId))
      .returning({ id: adminInvites.id });
    console.log(`Удалено инвайтов: ${deletedInvites.length}`);

    // Удаляем admin'а
    await db.delete(admins).where(eq(admins.id, existing.id));
    console.log(`Admin удалён: ${EMAIL}`);

    // Удаляем тенант если он был только у этого admin'а
    const otherAdmins = await db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.tenantId, existing.tenantId));

    if (otherAdmins.length === 0) {
      await db.delete(tenants).where(eq(tenants.id, existing.tenantId));
      console.log(`Тенант удалён: id=${existing.tenantId}`);
    } else {
      console.log(`Тенант оставлен — есть другие admin'ы (${otherAdmins.length})`);
    }
  } else {
    console.log(`Admin с email ${EMAIL} не найден — создаём с нуля`);
  }

  // 2. Создать новый тенант
  const nowEpoch = Math.floor(Date.now() / 1000);
  const slug = "chatman";

  const [newTenant] = await db
    .insert(tenants)
    .values({
      slug,
      plan: "free",
      status: "active",
      llmBillingMode: "byok",
      createdAt: nowEpoch,
      updatedAt: nowEpoch,
    })
    .returning();
  console.log(`Тенант создан: id=${newTenant!.id}, slug=${newTenant!.slug}`);

  // 3. Создать invite token
  const token = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const expiresAt = nowEpoch + 30 * 24 * 60 * 60; // 30 дней

  const [invite] = await db
    .insert(adminInvites)
    .values({
      tenantId: newTenant!.id,
      email: EMAIL,
      role: "superadmin",
      token,
      expiresAt,
      createdAt: nowEpoch,
    })
    .returning({ id: adminInvites.id });

  const inviteUrl = `${ADMIN_UI_BASE_URL}/accept-invite?token=${token}`;

  console.log("\n✅ Готово!");
  console.log(`Tenant ID  : ${newTenant!.id}`);
  console.log(`Tenant slug: ${newTenant!.slug}`);
  console.log(`Email      : ${EMAIL}`);
  console.log(`Invite URL : ${inviteUrl}`);
  console.log("\nОтправь пользователю ссылку — он сам задаст пароль при входе.");

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
