import { describe, expect, test } from "bun:test";
import { InMemoryConversationStore } from "./conversation-store.ts";

describe("InMemoryConversationStore — basic ops", () => {
  test("getHistory returns [] for unknown conversation", async () => {
    const store = new InMemoryConversationStore();
    expect(await store.getHistory("unknown")).toEqual([]);
  });

  test("addMessage + getHistory round-trips messages", async () => {
    const store = new InMemoryConversationStore();
    await store.addMessage("c1", { role: "user", content: "hi" });
    await store.addMessage("c1", { role: "assistant", content: "hello" });
    const history = await store.getHistory("c1");
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "hi" });
    expect(history[1]).toEqual({ role: "assistant", content: "hello" });
  });

  test("setHistory replaces history", async () => {
    const store = new InMemoryConversationStore();
    await store.addMessage("c2", { role: "user", content: "old" });
    await store.setHistory("c2", [{ role: "assistant", content: "new" }]);
    const history = await store.getHistory("c2");
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toBe("new");
  });

  test("setSummary + getSummary round-trips", async () => {
    const store = new InMemoryConversationStore();
    expect(await store.getSummary("c3")).toBeNull();
    await store.setSummary("c3", "some summary");
    expect(await store.getSummary("c3")).toBe("some summary");
  });

  test("deleteConversation clears history + summary", async () => {
    const store = new InMemoryConversationStore();
    await store.addMessage("c4", { role: "user", content: "x" });
    await store.setSummary("c4", "s");
    await store.deleteConversation("c4");
    expect(await store.getHistory("c4")).toEqual([]);
    expect(await store.getSummary("c4")).toBeNull();
  });

  test("maxHistoryLength caps history", async () => {
    const store = new InMemoryConversationStore({ maxHistoryLength: 3 });
    for (let i = 0; i < 5; i++) {
      await store.addMessage("c5", { role: "user", content: String(i) });
    }
    const history = await store.getHistory("c5");
    expect(history).toHaveLength(3);
    expect(history[0]?.content).toBe("2");
  });

  test("size counts active conversations", async () => {
    const store = new InMemoryConversationStore();
    expect(store.size).toBe(0);
    await store.addMessage("a", { role: "user", content: "x" });
    await store.addMessage("b", { role: "user", content: "y" });
    expect(store.size).toBe(2);
    await store.deleteConversation("a");
    expect(store.size).toBe(1);
  });

  test("TTL expiry returns empty history + null summary", async () => {
    const store = new InMemoryConversationStore({ ttlMs: 1 });
    await store.addMessage("c6", { role: "user", content: "x" });
    await store.setSummary("c6", "s");
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.getHistory("c6")).toEqual([]);
    expect(await store.getSummary("c6")).toBeNull();
  });

  test("getHistory returns a copy (immutable)", async () => {
    const store = new InMemoryConversationStore();
    await store.addMessage("c7", { role: "user", content: "x" });
    const h1 = await store.getHistory("c7");
    h1.push({ role: "assistant", content: "injected" });
    const h2 = await store.getHistory("c7");
    expect(h2).toHaveLength(1);
  });
});
