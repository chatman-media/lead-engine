import type { TelegramClient } from "telegram";
import { describe, expect, it } from "bun:test";
import {
  finishUserbotLogin,
  startUserbotLogin,
  submitUserbot2fa,
  submitUserbotCode,
  UserbotLoginError,
  type UserbotLoginErrorCode,
} from "./login.ts";

function fc(over: Record<string, unknown> = {}): TelegramClient {
  return {
    invoke: async () => ({}),
    getMe: async () => ({ id: 777, username: "u", phone: "+1" }),
    session: { save: () => "SESSION" },
    ...over,
  } as unknown as TelegramClient;
}
const throwing = (msg: string) =>
  fc({
    invoke: async () => {
      throw new Error(msg);
    },
  });
const code = (client: TelegramClient) =>
  submitUserbotCode({ client, phone: "+100", phoneCodeHash: "h", code: "12345" });

describe("UserbotLoginError", () => {
  it("несёт code/retryAfterSec/name", () => {
    const e = new UserbotLoginError("flood_wait", "msg", 30);
    expect(e.code).toBe("flood_wait");
    expect(e.retryAfterSec).toBe(30);
    expect(e.name).toBe("UserbotLoginError");
  });
});

describe("finishUserbotLogin", () => {
  it("собирает session + идентификаторы", async () => {
    expect(await finishUserbotLogin(fc())).toEqual({
      sessionString: "SESSION",
      userId: "777",
      username: "u",
      phone: "+1",
    });
  });
  it("null username/phone когда их нет", async () => {
    const r = await finishUserbotLogin(fc({ getMe: async () => ({ id: 1 }) }));
    expect(r.username).toBeNull();
    expect(r.phone).toBeNull();
  });
});

describe("submitUserbotCode", () => {
  it("успех → needs2fa:false + session", async () => {
    const r = await code(fc());
    expect(r).toMatchObject({ needs2fa: false, sessionString: "SESSION", userId: "777" });
  });
  it("SESSION_PASSWORD_NEEDED → needs2fa:true", async () => {
    expect(await code(throwing("SESSION_PASSWORD_NEEDED"))).toEqual({ needs2fa: true });
  });
});

describe("mapRpcError (через submitUserbotCode)", () => {
  const cases: Array<[string, UserbotLoginErrorCode, number | undefined]> = [
    ["FLOOD_WAIT_30", "flood_wait", 30],
    ["PHONE_NUMBER_INVALID", "phone_invalid", undefined],
    ["PHONE_CODE_EXPIRED", "code_expired", undefined],
    ["PHONE_CODE_INVALID", "code_invalid", undefined],
    ["что-то совсем другое", "unknown", undefined],
  ];
  for (const [raw, expectedCode, retry] of cases) {
    it(`${raw} → ${expectedCode}`, async () => {
      try {
        await code(throwing(raw));
        throw new Error("ожидалась ошибка");
      } catch (err) {
        expect(err).toBeInstanceOf(UserbotLoginError);
        expect((err as UserbotLoginError).code).toBe(expectedCode);
        if (retry !== undefined) expect((err as UserbotLoginError).retryAfterSec).toBe(retry);
      }
    });
  }
});

describe("submitUserbot2fa", () => {
  it("ошибка invoke → password_invalid", async () => {
    await expect(
      submitUserbot2fa({ client: throwing("PASSWORD_HASH_INVALID"), password: "p" }),
    ).rejects.toMatchObject({ code: "password_invalid" });
  });
});

describe("startUserbotLogin (через clientFactory)", () => {
  it("успех → { client, phoneCodeHash }", async () => {
    const fc = {
      connect: async () => {},
      sendCode: async () => ({ phoneCodeHash: "hash" }),
      disconnect: async () => {},
    };
    const r = await startUserbotLogin({
      apiId: 1,
      apiHash: "h",
      phone: "+100",
      clientFactory: (() => fc) as never,
    });
    expect(r.phoneCodeHash).toBe("hash");
    expect(r.client).toBe(fc as never);
  });

  it("ошибка sendCode → disconnect + mapRpcError", async () => {
    let disconnected = false;
    const fc = {
      connect: async () => {},
      sendCode: async () => {
        throw new Error("PHONE_NUMBER_INVALID");
      },
      disconnect: async () => {
        disconnected = true;
      },
    };
    await expect(
      startUserbotLogin({
        apiId: 1,
        apiHash: "h",
        phone: "+100",
        clientFactory: (() => fc) as never,
      }),
    ).rejects.toMatchObject({ code: "phone_invalid" });
    expect(disconnected).toBe(true);
  });
});
