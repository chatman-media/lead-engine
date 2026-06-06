import { describe, expect, it } from "bun:test";
import { resolveConversation } from "./conversation-resolver.ts";
import type { ConversationsRepo } from "./dal/index.ts";

function repo(existing?: unknown) {
  const created: Array<Record<string, unknown>> = [];
  const conversations = {
    findByContactAndSource: async () => existing,
    create: async (data: Record<string, unknown>) => {
      const c = { id: 100, ...data };
      created.push(c);
      return c;
    },
  } as unknown as ConversationsRepo;
  return { conversations, created };
}

describe("resolveConversation", () => {
  it("существующий диалог → created:false, без создания", async () => {
    const { conversations, created } = repo({ id: 7, source: "bot" });
    const res = await resolveConversation({ contactId: 1, channelKind: "telegram_bot", conversations, nowEpoch: 0 });
    expect(res.created).toBe(false);
    expect(res.conversation.id).toBe(7);
    expect(created).toHaveLength(0);
  });

  it("нет диалога → создаёт ai-mode, created:true", async () => {
    const { conversations, created } = repo(undefined);
    const res = await resolveConversation({ contactId: 1, channelKind: "telegram_bot", conversations, nowEpoch: 111 });
    expect(res.created).toBe(true);
    expect(created[0]).toMatchObject({ contactId: 1, mode: "ai", source: "bot", nowEpoch: 111 });
  });

  it("маппинг kind → source", async () => {
    const cases: Array<[string, string]> = [
      ["telegram_bot", "bot"],
      ["telegram_userbot", "userbot"],
      ["whatsapp", "bot"], // fallback
      ["web", "bot"], // fallback
    ];
    for (const [kind, source] of cases) {
      const { conversations, created } = repo(undefined);
      await resolveConversation({ contactId: 1, channelKind: kind, conversations, nowEpoch: 0 });
      expect(created[0]!.source).toBe(source);
    }
  });
});
