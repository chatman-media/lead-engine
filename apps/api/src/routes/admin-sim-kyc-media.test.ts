import { describe, expect, it } from "bun:test";
import {
  botRequestedKyc,
  buildSimKycMediaParts,
  SIM_KYC_PASSPORT_REF,
  SIM_KYC_VIDEO_REF,
} from "./admin-sim.ts";

describe("sim KYC media injection", () => {
  it("botRequestedKyc detects KYC requests from the bot reply", () => {
    expect(botRequestedKyc("Пришлите, пожалуйста, фото паспорта")).toBe(true);
    expect(botRequestedKyc("Нужен документ, удостоверяющий личность")).toBe(true);
    expect(botRequestedKyc("Запишите короткое видео-кружок с ФИО")).toBe(true);
    expect(botRequestedKyc("Для продолжения пройдите верификацию")).toBe(true);
  });

  it("botRequestedKyc ignores ordinary exchange prompts", () => {
    expect(botRequestedKyc("Какую сумму хотите обменять?")).toBe(false);
    expect(botRequestedKyc("Курс 0.58, отправьте оплату на реквизиты")).toBe(false);
    expect(botRequestedKyc("")).toBe(false);
  });

  it("buildSimKycMediaParts returns a passport photo + KYC video_note", () => {
    const parts = buildSimKycMediaParts("42");
    expect(parts.map((p) => p.kind)).toEqual(["photo", "video_note"]);
    const refs = parts.flatMap((p) => ("mediaRef" in p ? [p.mediaRef.externalRef] : []));
    expect(refs).toEqual([SIM_KYC_PASSPORT_REF, SIM_KYC_VIDEO_REF]);
    const channels = parts.flatMap((p) => ("mediaRef" in p ? [p.mediaRef.channelId] : []));
    expect(channels).toEqual(["42", "42"]);
  });
});
