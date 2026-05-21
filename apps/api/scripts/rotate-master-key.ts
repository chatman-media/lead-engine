#!/usr/bin/env bun
/**
 * Ротация PLATFORM_MASTER_KEY: перешифровать все tenant_secrets.encrypted_value
 * под новый ключ. AES-256-GCM ciphertext под старым ключом → plaintext
 * → новый ciphertext.
 *
 * Usage:
 *   OLD_MASTER_KEY=<old-hex> NEW_MASTER_KEY=<new-hex> \
 *     bun run apps/api/scripts/rotate-master-key.ts
 *
 * Idempotent: если row уже зашифрован новым ключом (повторный прогон),
 * decrypt со старым выдаст SecretCryptoError — мы fallback'нем на
 * decrypt с новым и пропустим row (no-op). Если ни old, ни new не
 * decrypt'ят — real corruption, останавливаемся с ошибкой и счётчиком
 * обработанных строк.
 *
 * Online migration: пока скрипт работает, app.api / worker должны
 * использовать OLD_MASTER_KEY (старые ciphertext'ы ещё в БД). После
 * окончания — деплой apps с NEW_MASTER_KEY.
 *
 * Env:
 *   DATABASE_URL
 *   OLD_MASTER_KEY — 64 hex chars
 *   NEW_MASTER_KEY — 64 hex chars (другой)
 */

import {
  decryptSecret,
  encryptSecret,
  SecretCryptoError,
} from "@chatman-media/conversation-engine";
import { tenantSecrets } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} required`);
  return v;
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  const oldKey = required("OLD_MASTER_KEY");
  const newKey = required("NEW_MASTER_KEY");

  if (oldKey === newKey) {
    throw new Error("OLD_MASTER_KEY и NEW_MASTER_KEY должны различаться");
  }

  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client);

  let rotated = 0;
  let alreadyNew = 0;
  let corrupted = 0;

  try {
    const rows = await db.select().from(tenantSecrets);
    console.log(`[rotate-master-key] candidates: ${rows.length}`);

    for (const row of rows) {
      let plaintext: string | null = null;
      // Попытка 1: decrypt со старым (norm path).
      try {
        plaintext = decryptSecret(oldKey, row.encryptedValue);
      } catch (err) {
        if (!(err instanceof SecretCryptoError)) throw err;
      }
      if (plaintext === null) {
        // Попытка 2: decrypt с новым (уже rotated в предыдущий прогон).
        try {
          decryptSecret(newKey, row.encryptedValue);
          alreadyNew += 1;
          continue;
        } catch {
          corrupted += 1;
          console.error(
            `[rotate-master-key] FAIL row id=${row.id} tenant=${row.tenantId} ` +
              `key=${row.key}: neither old nor new key decrypts`,
          );
          continue;
        }
      }

      const newCiphertext = encryptSecret(newKey, plaintext);
      await db
        .update(tenantSecrets)
        .set({ encryptedValue: newCiphertext, updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(tenantSecrets.id, row.id));
      rotated += 1;
    }

    console.log(
      `[rotate-master-key] done: rotated=${rotated} already_new=${alreadyNew} corrupted=${corrupted}`,
    );
    if (corrupted > 0) {
      console.error("[rotate-master-key] WARNING: corrupted rows present, investigate manually");
      process.exit(2);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[rotate-master-key] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
