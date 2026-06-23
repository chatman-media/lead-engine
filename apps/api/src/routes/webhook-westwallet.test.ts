import { describe, expect, it } from "bun:test";
import { westWalletIpnToken } from "../lib/exchange/westwallet-ipn.ts";
import { makeWestWalletWebhookRoutes } from "./webhook-westwallet.ts";

const MASTER = "0123456789abcdef0123456789abcdef";

// db is never touched on the auth-rejection / unknown-label paths.
// biome-ignore lint/suspicious/noExplicitAny: stub db
const stubDb = {} as any;

function app() {
  return makeWestWalletWebhookRoutes({ db: stubDb, masterKeyHex: MASTER });
}

function form(label?: string): RequestInit {
  const body = new URLSearchParams();
  if (label !== undefined) body.set("label", label);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

describe("westwallet webhook auth", () => {
  it("rejects a callback with no key (401, no DB touched)", async () => {
    const res = await app().request("/webhook/westwallet/42", form("le-42-1"));
    expect(res.status).toBe(401);
  });

  it("rejects a callback with a forged key (401)", async () => {
    const res = await app().request("/webhook/westwallet/42?key=deadbeef", form("le-42-1"));
    expect(res.status).toBe(401);
  });

  it("rejects a key minted for a different tenant (401)", async () => {
    const wrongTenantKey = westWalletIpnToken(99, MASTER);
    const res = await app().request(
      `/webhook/westwallet/42?key=${wrongTenantKey}`,
      form("le-42-1"),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid key and proceeds (unknown label → ignored, no DB)", async () => {
    const key = westWalletIpnToken(42, MASTER);
    const res = await app().request(`/webhook/westwallet/42?key=${key}`, form("not-a-le-label"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: boolean };
    expect(json.ignored).toBe(true);
  });

  it("rejects a bad tenant id before auth (400)", async () => {
    const res = await app().request("/webhook/westwallet/0?key=x", form("le-0-1"));
    expect(res.status).toBe(400);
  });
});
