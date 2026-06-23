import type { Inbound } from "@chatman-media/channel-core";
import { describe, expect, it } from "bun:test";
import { resolveContact } from "./contact-resolver.ts";
import type { ChannelIdentitiesRepo, ContactsRepo } from "./dal/index.ts";

const inbound = (over: Record<string, unknown> = {}): Inbound =>
  ({ externalUserId: "u1", externalUsername: "Alice", ...over }) as unknown as Inbound;

function repos(opts: { identity?: unknown; contactById?: unknown } = {}) {
  const created = {
    contacts: [] as Array<Record<string, unknown>>,
    identities: [] as Array<Record<string, unknown>>,
  };
  const contacts = {
    byId: async () => opts.contactById,
    create: async (data: Record<string, unknown>) => {
      const c = { id: 42, displayName: null, ...data };
      created.contacts.push(c);
      return c;
    },
  } as unknown as ContactsRepo;
  const identities = {
    find: async () => opts.identity,
    create: async (data: Record<string, unknown>) => {
      created.identities.push(data);
      return { id: 1, ...data };
    },
  } as unknown as ChannelIdentitiesRepo;
  return { contacts, identities, created };
}

describe("resolveContact", () => {
  it("существующая identity → возвращает существующий contact", async () => {
    const { contacts, identities } = repos({
      identity: { id: 9, contactId: 5 },
      contactById: { id: 5, displayName: "X" },
    });
    const c = await resolveContact({ inbound: inbound(), channelDbId: 1, contacts, identities });
    expect(c.id).toBe(5);
  });

  it("identity указывает на пропавший contact → ошибка", async () => {
    const { contacts, identities } = repos({
      identity: { id: 9, contactId: 7 },
      contactById: undefined,
    });
    await expect(
      resolveContact({ inbound: inbound(), channelDbId: 1, contacts, identities }),
    ).rejects.toThrow("missing contact");
  });

  it("нет identity → создаёт contact (displayName из username) + identity", async () => {
    const { contacts, identities, created } = repos({ identity: undefined });
    const c = await resolveContact({ inbound: inbound(), channelDbId: 3, contacts, identities });
    expect(c.id).toBe(42);
    expect(created.contacts[0]!.displayName).toBe("Alice");
    expect(created.identities[0]).toMatchObject({
      contactId: 42,
      channelId: 3,
      externalUserId: "u1",
    });
  });

  it("нет username → contact без displayName", async () => {
    const { contacts, identities, created } = repos({ identity: undefined });
    await resolveContact({
      inbound: inbound({ externalUsername: undefined }),
      channelDbId: 3,
      contacts,
      identities,
    });
    expect(created.contacts[0]!.displayName).toBeNull();
  });
});
