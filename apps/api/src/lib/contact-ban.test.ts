import { describe, expect, it } from "bun:test";
import {
  buildBannedAttributes,
  buildUnbannedAttributes,
  contactBanState,
  isContactBanned,
} from "./contact-ban.ts";

describe("isContactBanned", () => {
  it("null/пустой → false", () => {
    expect(isContactBanned(null)).toBe(false);
    expect(isContactBanned(undefined)).toBe(false);
    expect(isContactBanned("")).toBe(false);
  });

  it("битый JSON → false (parseJsonObject catch, lines 14-16)", () => {
    expect(isContactBanned("{not valid json")).toBe(false);
  });

  it("JSON-массив (не объект) → {} → false", () => {
    expect(isContactBanned("[1,2,3]")).toBe(false);
  });

  it("распознаёт все исторические признаки бана", () => {
    expect(isContactBanned('{"isBanned":true}')).toBe(true);
    expect(isContactBanned('{"banStatus":"banned"}')).toBe(true);
    expect(isContactBanned('{"ban":{"status":"banned"}}')).toBe(true);
    expect(isContactBanned('{"ban":{"banned":true}}')).toBe(true);
    expect(isContactBanned('{"moderation":{"status":"banned"}}')).toBe(true);
  });

  it("незабаненный контакт → false", () => {
    expect(isContactBanned('{"isBanned":false,"foo":"bar"}')).toBe(false);
  });
});

describe("contactBanState", () => {
  it("читает reason/bannedAt из ban-объекта", () => {
    const s = contactBanState('{"ban":{"status":"banned","reason":"spam","bannedAt":123}}');
    expect(s).toEqual({ banned: true, reason: "spam", bannedAt: 123 });
  });

  it("fallback на legacy banReason/bannedAt верхнего уровня", () => {
    const s = contactBanState('{"banStatus":"banned","banReason":"abuse","bannedAt":99}');
    expect(s).toEqual({ banned: true, reason: "abuse", bannedAt: 99 });
  });

  it("незабаненный → banned:false, поля null", () => {
    const s = contactBanState("{}");
    expect(s).toEqual({ banned: false, reason: null, bannedAt: null });
  });
});

describe("buildBannedAttributes", () => {
  it("проставляет признаки бана + сохраняет прочие атрибуты", () => {
    const out = buildBannedAttributes('{"displayName":"Bob"}', {
      adminId: 7,
      reason: "spam",
      now: 1000,
      source: "admin_inbox",
    });
    const parsed = JSON.parse(out);
    expect(parsed.displayName).toBe("Bob");
    expect(parsed.isBanned).toBe(true);
    expect(parsed.banStatus).toBe("banned");
    expect(parsed.ban).toMatchObject({
      status: "banned",
      banned: true,
      bannedByAdminId: 7,
      bannedAt: 1000,
      reason: "spam",
      source: "admin_inbox",
    });
  });

  it("пустой reason → null", () => {
    const out = buildBannedAttributes(null, { now: 1, source: "x" });
    expect(JSON.parse(out).banReason).toBeNull();
  });
});

describe("buildUnbannedAttributes", () => {
  it("снимает бан + сводка о прошлом состоянии", () => {
    const banned = buildBannedAttributes(null, {
      adminId: 1,
      reason: "spam",
      now: 500,
      source: "admin_lead_detail",
    });
    const res = buildUnbannedAttributes(banned, { adminId: 2, now: 900 });
    expect(res.wasBanned).toBe(true);
    expect(res.previousReason).toBe("spam");
    expect(res.previousBannedAt).toBe(500);
    const parsed = JSON.parse(res.attributesJson);
    expect(parsed.isBanned).toBe(false);
    expect(parsed.banStatus).toBe("unbanned");
    expect(parsed.ban).toMatchObject({
      status: "unbanned",
      banned: false,
      unbannedByAdminId: 2,
      unbannedAt: 900,
    });
  });

  it("moderation.status='banned' → переводится в 'cleared' (lines 135-136)", () => {
    const res = buildUnbannedAttributes('{"moderation":{"status":"banned","note":"x"}}', {
      now: 10,
    });
    const parsed = JSON.parse(res.attributesJson);
    expect(parsed.moderation).toEqual({ status: "cleared", note: "x" });
  });

  it("без moderation-бана → moderation не добавляется", () => {
    const res = buildUnbannedAttributes("{}", { now: 10 });
    const parsed = JSON.parse(res.attributesJson);
    expect(parsed.moderation).toBeUndefined();
    expect(res.wasBanned).toBe(false);
  });
});
