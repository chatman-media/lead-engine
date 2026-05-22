import { Api, TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";

/**
 * Пошаговый MTProto-логин для onboarding'а personal-account userbot'а.
 *
 * GramJS высокоуровневый `client.start()` интерактивен (callback'и для кода
 * и пароля) — не годится для stateless HTTP. Здесь логин разбит на шаги:
 *   1. startUserbotLogin(phone) → connect + sendCode → { client, phoneCodeHash }
 *   2. submitUserbotCode({client, code}) → auth.SignIn; при 2FA → needs2fa:true
 *   3. submitUserbot2fa({client, password}) → account.GetPassword + SRP CheckPassword
 *
 * Между шагами вызывающая сторона (apps/api) ДОЛЖНА держать тот же `client`
 * в памяти — phoneCodeHash и auth-key привязаны к этому live-соединению.
 * По завершении session-string сохраняется (encrypted) и адаптер reconnect'ится.
 */

export type UserbotLoginErrorCode =
  | "phone_invalid"
  | "code_invalid"
  | "code_expired"
  | "password_invalid"
  | "flood_wait"
  | "unknown";

export class UserbotLoginError extends Error {
  constructor(
    readonly code: UserbotLoginErrorCode,
    message: string,
    /** Для flood_wait — сколько секунд ждать. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "UserbotLoginError";
  }
}

export interface StartedUserbotLogin {
  client: TelegramClient;
  phoneCodeHash: string;
}

export interface FinishedUserbotLogin {
  sessionString: string;
  userId: string;
  username: string | null;
  phone: string | null;
}

const SESSION_PASSWORD_NEEDED = /SESSION_PASSWORD_NEEDED/i;

function mapRpcError(err: unknown): UserbotLoginError {
  const msg =
    err instanceof Error
      ? ((err as { errorMessage?: string }).errorMessage ?? err.message)
      : String(err);
  const floodMatch = /FLOOD_WAIT_(\d+)/i.exec(msg);
  if (floodMatch) {
    return new UserbotLoginError(
      "flood_wait",
      `Слишком много попыток — подождите ${floodMatch[1]} сек`,
      Number.parseInt(floodMatch[1] ?? "0", 10),
    );
  }
  if (/PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED|PHONE_NUMBER_UNOCCUPIED/i.test(msg)) {
    return new UserbotLoginError("phone_invalid", "Неверный номер телефона");
  }
  if (/PHONE_CODE_EXPIRED/i.test(msg)) {
    return new UserbotLoginError("code_expired", "Код истёк — запросите новый");
  }
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/i.test(msg)) {
    return new UserbotLoginError("code_invalid", "Неверный код");
  }
  if (/PASSWORD_HASH_INVALID/i.test(msg)) {
    return new UserbotLoginError("password_invalid", "Неверный пароль 2FA");
  }
  return new UserbotLoginError("unknown", msg);
}

/** Шаг 1: подключиться и отправить код подтверждения на номер. */
export async function startUserbotLogin(opts: {
  apiId: number;
  apiHash: string;
  phone: string;
}): Promise<StartedUserbotLogin> {
  const client = new TelegramClient(new StringSession(""), opts.apiId, opts.apiHash, {
    connectionRetries: 3,
  });
  await client.connect();
  try {
    const { phoneCodeHash } = await client.sendCode(
      { apiId: opts.apiId, apiHash: opts.apiHash },
      opts.phone,
    );
    return { client, phoneCodeHash };
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw mapRpcError(err);
  }
}

/**
 * Шаг 2: отправить код. Если у аккаунта включён 2FA — Telegram вернёт
 * SESSION_PASSWORD_NEEDED, возвращаем { needs2fa: true } (логин не завершён).
 * Иначе логин завершён — возвращаем session-string.
 */
export async function submitUserbotCode(opts: {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  code: string;
}): Promise<{ needs2fa: true } | ({ needs2fa: false } & FinishedUserbotLogin)> {
  try {
    await opts.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: opts.phone,
        phoneCodeHash: opts.phoneCodeHash,
        phoneCode: opts.code,
      }),
    );
  } catch (err) {
    const msg =
      err instanceof Error
        ? ((err as { errorMessage?: string }).errorMessage ?? err.message)
        : String(err);
    if (SESSION_PASSWORD_NEEDED.test(msg)) {
      return { needs2fa: true };
    }
    throw mapRpcError(err);
  }
  return { needs2fa: false, ...(await finishUserbotLogin(opts.client)) };
}

/** Шаг 3 (опционально): отправить пароль 2FA через SRP. */
export async function submitUserbot2fa(opts: {
  client: TelegramClient;
  password: string;
}): Promise<FinishedUserbotLogin> {
  try {
    const pwd = await opts.client.invoke(new Api.account.GetPassword());
    const input = await computeCheck(pwd, opts.password);
    await opts.client.invoke(new Api.auth.CheckPassword({ password: input }));
  } catch (err) {
    throw mapRpcError(err);
  }
  return finishUserbotLogin(opts.client);
}

/** Сохранить session-string + получить идентификаторы аккаунта. */
export async function finishUserbotLogin(client: TelegramClient): Promise<FinishedUserbotLogin> {
  const me = (await client.getMe()) as Api.User;
  const sessionString = client.session.save() as unknown as string;
  return {
    sessionString,
    userId: String(me.id),
    username: me.username ?? null,
    phone: me.phone ?? null,
  };
}
