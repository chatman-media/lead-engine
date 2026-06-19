import { beforeEach, describe, expect, it } from "bun:test";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import type { ContactsRepo } from "./dal/contacts.ts";
import type { MessagesRepo } from "./dal/messages.ts";
import { LlmMemoryExtractor, runMemoryExtraction } from "./memory-extractor.ts";
import { FakeContactsRepo } from "./testkit.ts";

class FakeChatClient implements ChatClient {
  lastMessages: ChatMessage[] | null = null;
  constructor(public readonly response: string) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    return this.response;
  }
}

function fakeMessagesRepo(history: Array<{ role: "user" | "assistant"; text: string }>) {
  return {
    recent: async () =>
      history.map((h, i) => ({
        id: i + 1,
        tenantId: 1,
        conversationId: 100,
        role: h.role,
        text: h.text,
        tgMessageId: null,
        metaJson: null,
        createdAt: 1700000000 + i,
        stage: null,
        deletedAt: null,
        origLang: null,
        translatedText: null,
        translatedLang: null,
      })),
  } as unknown as MessagesRepo;
}

describe("LlmMemoryExtractor", () => {
  it("вызывает chat.complete и парсит JSON-ответ", async () => {
    const chat = new FakeChatClient('{"name":"Алина","city":"Москва"}');
    const repo = fakeMessagesRepo([{ role: "user", text: "Меня зовут Алина, я из Москвы" }]);
    const extractor = new LlmMemoryExtractor({ resolveChat: () => chat }, () => repo);
    const facts = await extractor.extract({
      tenantId: 1,
      conversationId: 100,
      contactId: 1,
      existingFacts: {},
    });
    expect(facts).toEqual({ name: "Алина", city: "Москва" });
    // System prompt + user prompt отправлены.
    expect(chat.lastMessages?.[0]?.role).toBe("system");
  });

  it("прокидывает existing facts в LLM для context", async () => {
    const chat = new FakeChatClient("{}");
    const repo = fakeMessagesRepo([{ role: "user", text: "ничего нового" }]);
    const extractor = new LlmMemoryExtractor({ resolveChat: () => chat }, () => repo);
    await extractor.extract({
      tenantId: 1,
      conversationId: 100,
      contactId: 1,
      existingFacts: { name: "Алина" },
    });
    const userPrompt = chat.lastMessages?.[1]?.content;
    expect(userPrompt).toContain("Алина");
  });

  it("пустая history → возвращает {} без LLM call", async () => {
    const chat = new FakeChatClient("{}");
    const repo = fakeMessagesRepo([]);
    const extractor = new LlmMemoryExtractor({ resolveChat: () => chat }, () => repo);
    const facts = await extractor.extract({
      tenantId: 1,
      conversationId: 100,
      contactId: 1,
      existingFacts: {},
    });
    expect(facts).toEqual({});
    expect(chat.lastMessages).toBeNull();
  });

  it("prepared history → не читает MessagesRepo вне caller snapshot", async () => {
    const chat = new FakeChatClient('{"city":"Bangkok"}');
    const extractor = new LlmMemoryExtractor(
      { resolveChat: () => chat },
      () =>
        ({
          recent: async () => {
            throw new Error("repo should not be called");
          },
        }) as unknown as MessagesRepo,
    );

    const facts = await extractor.extract({
      tenantId: 1,
      conversationId: 100,
      contactId: 1,
      existingFacts: {},
      history: [
        {
          id: 1,
          tenantId: 1,
          conversationId: 100,
          role: "user",
          text: "Я сейчас в Бангкоке",
          tgMessageId: null,
          metaJson: null,
          createdAt: 1700000000,
          stage: null,
          deletedAt: null,
          origLang: null,
          translatedText: null,
          translatedLang: null,
        },
      ],
    });

    expect(facts).toEqual({ city: "Bangkok" });
    expect(
      chat.lastMessages?.some(
        (m) => typeof m.content === "string" && m.content.includes("Бангкоке"),
      ),
    ).toBe(true);
  });
});

describe("runMemoryExtraction", () => {
  let contacts: FakeContactsRepo;
  beforeEach(() => {
    contacts = new FakeContactsRepo(1);
  });

  it("читает existing string-facts из attributes_json и merge'ит новые", async () => {
    const contact = await contacts.create({
      attributesJson: JSON.stringify({ name: "Алина", age: 25 }),
    });
    const extractor: import("./memory-extractor.ts").MemoryExtractor = {
      extract: async (input) => {
        expect(input.existingFacts).toEqual({ name: "Алина" });
        return { city: "Москва" };
      },
    };
    const newFacts = await runMemoryExtraction({
      extractor,
      tenantId: 1,
      conversationId: 100,
      contactId: contact.id,
      contacts: contacts as unknown as ContactsRepo,
      nowEpoch: 1700000001,
    });
    expect(newFacts).toEqual({ city: "Москва" });
    // Merge сохранил age (хотя age — number — не считается "fact" для LLM,
    // но ContactsRepo.mergeAttributes — generic merge).
    const updated = contacts.all()[0]!;
    const json = JSON.parse(updated.attributesJson!) as Record<string, unknown>;
    expect(json).toEqual({ name: "Алина", age: 25, city: "Москва" });
  });

  it("пустые newFacts → не делает UPDATE attributes_json", async () => {
    const contact = await contacts.create({});
    const extractor: import("./memory-extractor.ts").MemoryExtractor = {
      extract: async () => ({}),
    };
    await runMemoryExtraction({
      extractor,
      tenantId: 1,
      conversationId: 100,
      contactId: contact.id,
      contacts: contacts as unknown as ContactsRepo,
      nowEpoch: 1700000001,
    });
    const updated = contacts.all()[0]!;
    expect(updated.attributesJson).toBeNull();
  });

  it("неизвестный contactId → возвращает {} без ошибок", async () => {
    const extractor: import("./memory-extractor.ts").MemoryExtractor = {
      extract: async () => ({ x: "y" }),
    };
    const result = await runMemoryExtraction({
      extractor,
      tenantId: 1,
      conversationId: 100,
      contactId: 999,
      contacts: contacts as unknown as ContactsRepo,
      nowEpoch: 1700000001,
    });
    expect(result).toEqual({});
  });
});
