import { describe, expect, it } from "bun:test";
import { OllamaChatClient } from "./providers/ollama-chat.ts";
import { OpenAIChatClient } from "./providers/openai-chat.ts";
import { OpenAIEmbeddingClient } from "./providers/openai-embed.ts";
import { InMemoryLlmRouter } from "./router.ts";

describe("InMemoryLlmRouter", () => {
  it("резолвит chat-клиента по (tenantId, purpose)", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 1,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });
    const c = r.resolveChat(1, "chat");
    expect(c).toBeInstanceOf(OpenAIChatClient);
  });

  it("кэширует одного и того же клиента для повторных вызовов", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 1,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });
    const a = r.resolveChat(1, "chat");
    const b = r.resolveChat(1, "chat");
    expect(a).toBe(b);
  });

  it("разрешает разные purpose'ы на разные клиенты (chat=openai, vision=ollama)", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 2,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
    });
    r.setConfig({
      tenantId: 2,
      purpose: "vision",
      provider: "ollama",
      model: "qwen2.5vl",
    });
    expect(r.resolveChat(2, "chat")).toBeInstanceOf(OpenAIChatClient);
    expect(r.resolveChat(2, "vision")).toBeInstanceOf(OllamaChatClient);
  });

  it("invalidate(tenant) сбрасывает кэш — следующий resolve пересобирает клиента", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 1,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
    });
    const a = r.resolveChat(1, "chat");
    r.invalidate(1);
    const b = r.resolveChat(1, "chat");
    expect(a).not.toBe(b);
  });

  it("setConfig перезаписывает существующий — новый resolve даёт новый клиент с новыми credentials", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 1,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-OLD",
    });
    const a = r.resolveChat(1, "chat");
    r.setConfig({
      tenantId: 1,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-NEW",
    });
    const b = r.resolveChat(1, "chat");
    expect(a).not.toBe(b);
  });

  it("бросает явную ошибку если конфиг для (tenantId, purpose) не выставлен", () => {
    const r = new InMemoryLlmRouter();
    expect(() => r.resolveChat(99, "chat")).toThrow(/tenantId=99/);
    expect(() => r.resolveEmbed(99)).toThrow(/tenantId=99/);
  });

  it("резолвит embed с embedDim", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 5,
      purpose: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      embedDim: 1536,
    });
    const e = r.resolveEmbed(5);
    expect(e).toBeInstanceOf(OpenAIEmbeddingClient);
    expect(e.dim).toBe(1536);
  });

  it("embed-конфиг без embedDim — explicit error", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 5,
      purpose: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
    });
    expect(() => r.resolveEmbed(5)).toThrow(/embedDim/);
  });

  it("knownTenants() возвращает отсортированный список", () => {
    const r = new InMemoryLlmRouter();
    r.setConfig({
      tenantId: 7,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "k",
    });
    r.setConfig({
      tenantId: 2,
      purpose: "chat",
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "k",
    });
    r.setConfig({
      tenantId: 7,
      purpose: "embed",
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "k",
      embedDim: 1536,
    });
    expect(r.knownTenants()).toEqual([2, 7]);
  });
});
