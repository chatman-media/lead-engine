import { describe, expect, it } from "bun:test";
import { signWebSession } from "../lib/web-session-token.ts";
import { makeWebSocketRoutes } from "./ws-web.ts";

const SECRET = "ws-signing-secret";

function makeStubRegistry() {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  return {
    byTenant: (slug: string) => (slug === "acme" ? { channelDbId: 7, adapter: {} } : undefined),
    byChannelId: () => undefined,
    size: () => 1,
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  } as any;
}

function makeRoutes() {
  return makeWebSocketRoutes({
    registry: makeStubRegistry(),
    // biome-ignore lint/suspicious/noExplicitAny: log unused by tryUpgrade
    log: {} as any,
    signingSecret: SECRET,
  });
}

function stubServer() {
  let captured: unknown = null;
  const server = {
    upgrade: (_req: Request, opts?: { data?: unknown }) => {
      captured = opts?.data ?? null;
      return true;
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Bun.Server stub
  } as any;
  return { server, getData: () => captured as Record<string, unknown> | null };
}

describe("ws-web tryUpgrade identity binding", () => {
  it("issues a fresh bound session for a new visitor (no user param)", () => {
    const { tryUpgrade } = makeRoutes();
    const { server, getData } = stubServer();
    const res = tryUpgrade(new Request("http://h/ws/acme"), server);
    expect(res).toBeUndefined(); // upgrade succeeded
    const data = getData();
    expect(typeof data?.externalUserId).toBe("string");
    expect((data?.externalUserId as string).startsWith("web-")).toBe(true);
    expect(typeof data?.issuedToken).toBe("string"); // token delivered on open
  });

  it("accepts a valid user+token and does not re-issue", () => {
    const { tryUpgrade } = makeRoutes();
    const { server, getData } = stubServer();
    const userId = "web-abc123";
    const token = signWebSession("acme", userId, SECRET);
    const res = tryUpgrade(new Request(`http://h/ws/acme?user=${userId}&token=${token}`), server);
    expect(res).toBeUndefined();
    const data = getData();
    expect(data?.externalUserId).toBe(userId);
    expect(data?.issuedToken).toBeNull();
  });

  it("rejects a user with an invalid/forged token (401)", () => {
    const { tryUpgrade } = makeRoutes();
    const { server } = stubServer();
    const res = tryUpgrade(new Request("http://h/ws/acme?user=web-victim&token=deadbeef"), server);
    expect(res?.status).toBe(401);
  });

  it("rejects a user param with no token (401) — no unbound ids", () => {
    const { tryUpgrade } = makeRoutes();
    const { server } = stubServer();
    const res = tryUpgrade(new Request("http://h/ws/acme?user=web-someone"), server);
    expect(res?.status).toBe(401);
  });

  it("rejects a victim's token reused under attacker's id (401)", () => {
    const { tryUpgrade } = makeRoutes();
    const { server } = stubServer();
    const victimToken = signWebSession("acme", "web-victim", SECRET);
    const res = tryUpgrade(
      new Request(`http://h/ws/acme?user=web-attacker&token=${victimToken}`),
      server,
    );
    expect(res?.status).toBe(401);
  });

  it("404s for an unknown tenant", () => {
    const { tryUpgrade } = makeRoutes();
    const { server } = stubServer();
    const res = tryUpgrade(new Request("http://h/ws/nope"), server);
    expect(res?.status).toBe(404);
  });

  it("400s when slug is missing", () => {
    const { tryUpgrade } = makeRoutes();
    const { server } = stubServer();
    const res = tryUpgrade(new Request("http://h/ws/"), server);
    expect(res?.status).toBe(400);
  });
});
