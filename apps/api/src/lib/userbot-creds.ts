import {
  type Db,
  getDecryptedSecret,
  setEncryptedSecret,
} from "@chatman-media/conversation-engine";

/**
 * Per-tenant резолв MTProto app-кредов (api_id/api_hash с my.telegram.org)
 * для personal-account userbot'а.
 *
 * Раньше эти креды были платформенными (env TELEGRAM_API_ID/HASH) — единый
 * app на всю платформу. Теперь тенант вводит свои в кабинете; они шифруются в
 * `tenant_secrets` под ключами TELEGRAM_API_ID_KEY / TELEGRAM_API_HASH_KEY.
 * Env-значения остаются опциональным общим фолбэком (см. resolveUserbotCreds).
 *
 * Зеркалит паттерн ChannelRegistry.resolveBotToken: сначала tenant_secrets,
 * потом env-фолбэк.
 */

export const TELEGRAM_API_ID_KEY = "telegram_api_id";
export const TELEGRAM_API_HASH_KEY = "telegram_api_hash";

export interface UserbotCreds {
  apiId: number;
  apiHash: string;
}

/**
 * Резолв api_id/api_hash для тенанта. Priority:
 *   1. tenant_secrets[telegram_api_id|telegram_api_hash] (decrypt).
 *   2. env-фолбэк (fallbackApiId/fallbackApiHash, прокинутые из cfg).
 * Возвращает null если ни per-tenant, ни фолбэк не дают валидную пару.
 */
export async function resolveUserbotCreds(opts: {
  db: Db;
  tenantId: number;
  masterKeyHex: string;
  fallbackApiId?: number;
  fallbackApiHash?: string;
  onWarn?: (msg: string, ctx: Record<string, unknown>) => void;
}): Promise<UserbotCreds | null> {
  let apiId = 0;
  let apiHash = "";
  try {
    const [idStr, hash] = await Promise.all([
      getDecryptedSecret({
        db: opts.db,
        tenantId: opts.tenantId,
        key: TELEGRAM_API_ID_KEY,
        masterKeyHex: opts.masterKeyHex,
      }),
      getDecryptedSecret({
        db: opts.db,
        tenantId: opts.tenantId,
        key: TELEGRAM_API_HASH_KEY,
        masterKeyHex: opts.masterKeyHex,
      }),
    ]);
    if (idStr && hash) {
      apiId = Number.parseInt(idStr, 10);
      apiHash = hash;
    }
  } catch (err) {
    opts.onWarn?.("failed to decrypt userbot api creds", {
      tenantId: opts.tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!(apiId > 0) || !apiHash) {
    apiId = opts.fallbackApiId ?? 0;
    apiHash = opts.fallbackApiHash ?? "";
  }

  if (!(apiId > 0) || !apiHash) return null;
  return { apiId, apiHash };
}

/** Сохранить per-tenant api_id/api_hash (шифрованно) в tenant_secrets. */
export async function setUserbotCreds(opts: {
  db: Db;
  tenantId: number;
  apiId: number;
  apiHash: string;
  masterKeyHex: string;
  nowEpoch: number;
}): Promise<void> {
  await setEncryptedSecret({
    db: opts.db,
    tenantId: opts.tenantId,
    key: TELEGRAM_API_ID_KEY,
    value: String(opts.apiId),
    masterKeyHex: opts.masterKeyHex,
    nowEpoch: opts.nowEpoch,
  });
  await setEncryptedSecret({
    db: opts.db,
    tenantId: opts.tenantId,
    key: TELEGRAM_API_HASH_KEY,
    value: opts.apiHash,
    masterKeyHex: opts.masterKeyHex,
    nowEpoch: opts.nowEpoch,
  });
}
