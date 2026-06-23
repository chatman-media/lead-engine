import { describe, expect, it } from "bun:test";
import { newWebUserId, signWebSession, verifyWebSession } from "./web-session-token.ts";

const SECRET = "test-secret-key";

describe("web-session-token", () => {
  it("verifies a freshly signed token", () => {
    const id = newWebUserId();
    const token = signWebSession("acme", id, SECRET);
    expect(verifyWebSession("acme", id, token, SECRET)).toBe(true);
  });

  it("rejects a token bound to a different userId (no impersonation)", () => {
    const token = signWebSession("acme", "web-victim", SECRET);
    expect(verifyWebSession("acme", "web-attacker", token, SECRET)).toBe(false);
    // Attacker cannot reuse the victim's token under their own id.
    expect(verifyWebSession("acme", "web-victim", token, SECRET)).toBe(true);
  });

  it("rejects a token bound to a different tenant slug", () => {
    const id = newWebUserId();
    const token = signWebSession("acme", id, SECRET);
    expect(verifyWebSession("other", id, token, SECRET)).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const id = newWebUserId();
    const token = signWebSession("acme", id, SECRET);
    expect(verifyWebSession("acme", id, token, "wrong-secret")).toBe(false);
  });

  it("rejects empty / missing tokens", () => {
    const id = newWebUserId();
    expect(verifyWebSession("acme", id, "", SECRET)).toBe(false);
    expect(verifyWebSession("acme", id, "deadbeef", SECRET)).toBe(false);
  });

  it("mints unguessable, unique ids", () => {
    const a = newWebUserId();
    const b = newWebUserId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^web-[0-9a-f]{32}$/);
  });
});
