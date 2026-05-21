import type { StageClassifier } from "@chatman-media/conversation-engine";
import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";
import { describe, expect, it } from "bun:test";
import { LlmStageClassifier, RegexStageClassifier } from "./stage-classifier.ts";

describe("RegexStageClassifier", () => {
  const c = new RegexStageClassifier();

  it("первое сообщение без сигналов → opener", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "Здравствуйте",
      previousStage: null,
      isFirstUserMessage: true,
    });
    expect(result).toBe("opener");
  });

  it("кандидат делится данными о себе → qualify", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "Меня зовут Алина, мне 22, я из Москвы",
      previousStage: null,
      isFirstUserMessage: false,
    });
    expect(result).toBe("qualify");
  });

  it("вопрос про оплату → pitch", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "Сколько платят?",
      previousStage: "qualify",
      isFirstUserMessage: false,
    });
    expect(result).toBe("pitch");
  });

  it("сомнение → objection", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "А почему именно ваше агентство?",
      previousStage: "pitch",
      isFirstUserMessage: false,
    });
    expect(result).toBe("objection");
  });

  it("согласие → close", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "Давайте попробуем",
      previousStage: "pitch",
      isFirstUserMessage: false,
    });
    expect(result).toBe("close");
  });

  it("close имеет приоритет над objection при одновременном match'е", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "Хорошо, согласна попробовать. Почему нет?",
      previousStage: "pitch",
      isFirstUserMessage: false,
    });
    expect(result).toBe("close");
  });

  it("нет сигналов на non-first → возвращает previousStage", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "ага",
      previousStage: "pitch",
      isFirstUserMessage: false,
    });
    expect(result).toBe("pitch");
  });

  it("пустой текст → возвращает previousStage", async () => {
    const result = await c.classify({ tenantId: 1,
      userMessageText: "",
      previousStage: "qualify",
      isFirstUserMessage: false,
    });
    expect(result).toBe("qualify");
  });
});

class FakeChatClient implements ChatClient {
  lastMessages: ChatMessage[] | null = null;
  constructor(public readonly reply: string) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    return this.reply;
  }
}

describe("LlmStageClassifier", () => {
  it("парсит JSON-ответ выше threshold → возвращает stage", async () => {
    const chat = new FakeChatClient('{"stage":"pitch","confidence":0.9}');
    const classifier: StageClassifier = new LlmStageClassifier({
      resolveChat: () => chat,

    });
    const result = await classifier.classify({ tenantId: 1,
      userMessageText: "Сколько платят?",
      previousStage: "qualify",
      isFirstUserMessage: false,
    });
    expect(result).toBe("pitch");
    expect(chat.lastMessages?.[0]?.role).toBe("system");
  });

  it("confidence ниже threshold → fallback на previousStage", async () => {
    const chat = new FakeChatClient('{"stage":"close","confidence":0.3}');
    const classifier = new LlmStageClassifier({
      resolveChat: () => chat,

      confidenceThreshold: 0.6,
    });
    const result = await classifier.classify({ tenantId: 1,
      userMessageText: "м-м-м",
      previousStage: "objection",
      isFirstUserMessage: false,
    });
    expect(result).toBe("objection");
  });

  it("LLM вернул unknown stage → fallback на previousStage", async () => {
    const chat = new FakeChatClient('{"stage":"unknown_stage","confidence":0.9}');
    const classifier = new LlmStageClassifier({ resolveChat: () => chat});
    const result = await classifier.classify({ tenantId: 1,
      userMessageText: "Hi",
      previousStage: "qualify",
      isFirstUserMessage: false,
    });
    expect(result).toBe("qualify");
  });

  it("битый JSON → fallback на previousStage без crash'а", async () => {
    const chat = new FakeChatClient("Sorry, I cannot classify this.");
    const classifier = new LlmStageClassifier({ resolveChat: () => chat});
    const result = await classifier.classify({ tenantId: 1,
      userMessageText: "Hi",
      previousStage: "opener",
      isFirstUserMessage: false,
    });
    expect(result).toBe("opener");
  });

  it("пустой userMessageText → возвращает previousStage без LLM call", async () => {
    const chat = new FakeChatClient("never");
    const classifier = new LlmStageClassifier({ resolveChat: () => chat});
    const result = await classifier.classify({ tenantId: 1,
      userMessageText: "",
      previousStage: "pitch",
      isFirstUserMessage: false,
    });
    expect(result).toBe("pitch");
    expect(chat.lastMessages).toBeNull();
  });
});
