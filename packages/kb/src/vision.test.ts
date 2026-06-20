// Unit tests for the vision helpers: photo classification + passport identity
// extraction. Both hit an OpenAI-compatible /chat/completions endpoint, so the
// transport is exercised with a mock `fetch` (request shape, response parsing,
// error branches). Pure parsers (`parsePhotoClass`, `parsePassportJson`) are
// tested directly.

import { describe, expect, it } from "bun:test";
import type { FetchLike } from "@chatman-media/llm-router";
import {
  type ClassifyPhotoOptions,
  classifyPhoto,
  extractPassportIdentity,
  parsePassportJson,
  parsePhotoClass,
} from "./vision.ts";

const bytes = new TextEncoder().encode("fake-image").buffer as ArrayBuffer;

interface MockCall {
  url: string;
  init: RequestInit;
}

/** Mock fetch that records the call and returns a JSON response. */
function mockFetch(opts: {
  status?: number;
  body?: unknown;
  nonJson?: boolean;
  calls?: MockCall[];
}): FetchLike {
  const status = opts.status ?? 200;
  return (async (url: string, init: RequestInit) => {
    opts.calls?.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.nonJson) throw new Error("invalid json");
        return opts.body ?? {};
      },
    } as Response;
  }) as unknown as FetchLike;
}

function reply(content: string | undefined, finish = "stop") {
  return { choices: [{ message: { content }, finish_reason: finish }] };
}

const base: Omit<ClassifyPhotoOptions, "fetch"> = {
  bytes,
  model: "vision-model",
  apiKey: "sk-test",
};

describe("parsePhotoClass", () => {
  it("распознаёт каждую категорию из свободного текста", () => {
    expect(parsePhotoClass("passport")).toBe("passport");
    expect(parsePhotoClass("это full_body фото")).toBe("full_body");
    expect(parsePhotoClass("PORTRAIT.")).toBe("portrait");
    expect(parsePhotoClass("other")).toBe("other");
  });
  it("неизвестный ответ → other", () => {
    expect(parsePhotoClass("не знаю")).toBe("other");
    expect(parsePhotoClass("")).toBe("other");
  });
});

describe("classifyPhoto", () => {
  it("требует apiKey", async () => {
    await expect(classifyPhoto({ ...base, apiKey: "  ", fetch: mockFetch({}) })).rejects.toThrow(
      /apiKey required/,
    );
  });

  it("openrouter (default): шлёт reasoning:{enabled:false}, data-url, парсит ответ", async () => {
    const calls: MockCall[] = [];
    const cls = await classifyPhoto({
      ...base,
      fetch: mockFetch({ body: reply("full_body"), calls }),
    });
    expect(cls).toBe("full_body");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.model).toBe("vision-model");
    const imgPart = body.messages[1].content.find((p: { type: string }) => p.type === "image_url");
    expect(imgPart.image_url.url).toStartWith("data:image/jpeg;base64,");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("openai provider: НЕ шлёт reasoning", async () => {
    const calls: MockCall[] = [];
    await classifyPhoto({
      ...base,
      provider: "openai",
      fetch: mockFetch({ body: reply("portrait"), calls }),
    });
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.reasoning).toBeUndefined();
  });

  it("custom baseUrl c хвостовыми слэшами нормализуется + mimeType", async () => {
    const calls: MockCall[] = [];
    await classifyPhoto({
      ...base,
      baseUrl: "https://api.example.com/v9///",
      mimeType: "image/png",
      fetch: mockFetch({ body: reply("other"), calls }),
    });
    expect(calls[0]?.url).toBe("https://api.example.com/v9/chat/completions");
    const body = JSON.parse(calls[0]?.init.body as string);
    const imgPart = body.messages[1].content.find((p: { type: string }) => p.type === "image_url");
    expect(imgPart.image_url.url).toStartWith("data:image/png;base64,");
  });

  it("HTTP-ошибка → throw с кодом", async () => {
    await expect(
      classifyPhoto({
        ...base,
        fetch: mockFetch({ status: 500, body: { error: { message: "boom" } } }),
      }),
    ).rejects.toThrow(/vision API error \(HTTP 500\): boom/);
  });

  it("payload.error при ok → throw", async () => {
    await expect(
      classifyPhoto({ ...base, fetch: mockFetch({ body: { error: { message: "rate" } } }) }),
    ).rejects.toThrow(/rate/);
  });

  it("не-JSON ответ → throw", async () => {
    await expect(
      classifyPhoto({ ...base, fetch: mockFetch({ status: 502, nonJson: true }) }),
    ).rejects.toThrow(/non-JSON response \(HTTP 502\)/);
  });

  it("пустой content → throw с finish_reason", async () => {
    await expect(
      classifyPhoto({ ...base, fetch: mockFetch({ body: reply(undefined, "length") }) }),
    ).rejects.toThrow(/empty content \(finish_reason=length\)/);
  });
});

describe("parsePassportJson", () => {
  it("чистый JSON → trim + забор только известных полей", () => {
    expect(parsePassportJson('{"family_name":" IVANOV ","given_name":"ANNA","extra":"x"}')).toEqual(
      { family_name: "IVANOV", given_name: "ANNA" },
    );
  });
  it("снимает think-теги и code-fence", () => {
    expect(
      parsePassportJson('<think>hmm</think>```json\n{"passport_number":"12 34"}\n```'),
    ).toEqual({ passport_number: "12 34" });
  });
  it("нет фигурных скобок → {}", () => {
    expect(parsePassportJson("ничего")).toEqual({});
  });
  it("битый JSON → {}", () => {
    expect(parsePassportJson("{ broken")).toEqual({});
  });
  it("есть скобки но невалидный JSON → {}", () => {
    expect(parsePassportJson("{not: valid json}")).toEqual({});
  });
  it("массив / не-объект → {}", () => {
    expect(parsePassportJson("[1,2,3]")).toEqual({});
  });
  it("пустые / слишком длинные значения отбрасываются", () => {
    const long = "x".repeat(101);
    expect(parsePassportJson(`{"family_name":"   ","given_name":"${long}"}`)).toEqual({});
  });
});

describe("extractPassportIdentity", () => {
  it("требует apiKey", async () => {
    await expect(
      extractPassportIdentity({ ...base, apiKey: "", fetch: mockFetch({}) }),
    ).rejects.toThrow(/apiKey required/);
  });
  it("парсит поля из ответа модели", async () => {
    const r = await extractPassportIdentity({
      ...base,
      fetch: mockFetch({ body: reply('{"family_name":"PETROV","passport_expiry":"01.02.2030"}') }),
    });
    expect(r).toEqual({ family_name: "PETROV", passport_expiry: "01.02.2030" });
  });
  it("HTTP-ошибка → throw", async () => {
    await expect(
      extractPassportIdentity({ ...base, fetch: mockFetch({ status: 403, body: {} }) }),
    ).rejects.toThrow(/OpenRouter error \(HTTP 403\)/);
  });
  it("не-JSON → throw", async () => {
    await expect(
      extractPassportIdentity({ ...base, fetch: mockFetch({ status: 500, nonJson: true }) }),
    ).rejects.toThrow(/non-JSON response/);
  });
  it("пустой content → throw", async () => {
    await expect(
      extractPassportIdentity({ ...base, fetch: mockFetch({ body: reply(undefined) }) }),
    ).rejects.toThrow(/empty content/);
  });
});
