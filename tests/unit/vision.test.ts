import { describe, expect, test } from "bun:test";

import {
  classifyPhoto,
  extractInternalPassportIdentity,
  extractPassportIdentity,
  parseInternalPassportJson,
  parsePassportJson,
  parsePhotoClass,
} from "@/rag/vision.ts";

describe("parsePhotoClass", () => {
  test("recognises each class verbatim", () => {
    expect(parsePhotoClass("passport")).toBe("passport");
    expect(parsePhotoClass("full_body")).toBe("full_body");
    expect(parsePhotoClass("portrait")).toBe("portrait");
    expect(parsePhotoClass("other")).toBe("other");
  });

  test("extracts the class from a noisy reply", () => {
    expect(parsePhotoClass("Это passport.")).toBe("passport");
    expect(parsePhotoClass("  FULL_BODY\n")).toBe("full_body");
  });

  test("recognises internal_passport without it being shadowed by passport", () => {
    expect(parsePhotoClass("internal_passport")).toBe("internal_passport");
    expect(parsePhotoClass("Это internal_passport.")).toBe("internal_passport");
  });

  test("falls back to other on garbage", () => {
    expect(parsePhotoClass("дом")).toBe("other");
    expect(parsePhotoClass("")).toBe("other");
  });
});

describe("classifyPhoto", () => {
  test("posts an image data URL and returns the parsed class", async () => {
    let capturedBody: { messages: Array<{ content: unknown }> } | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "passport" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const out = await classifyPhoto({
      bytes: new TextEncoder().encode("fakeimg").buffer as ArrayBuffer,
      mimeType: "image/png",
      model: "google/gemini-2.5-flash",
      apiKey: "k",
      fetch: fakeFetch,
    });

    expect(out).toBe("passport");
    const content = capturedBody?.messages[1]?.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content[1]?.type).toBe("image_url");
    expect(content[1]?.image_url?.url).toStartWith("data:image/png;base64,");
  });

  test("openrouter provider sends the reasoning param", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "other" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await classifyPhoto({
      bytes: new ArrayBuffer(4),
      model: "google/gemini-2.5-flash",
      apiKey: "k",
      provider: "openrouter",
      fetch: fakeFetch,
    });

    expect(capturedBody?.reasoning).toEqual({ enabled: false });
  });

  test("openai provider omits the reasoning param and hits the given base URL", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "portrait" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const out = await classifyPhoto({
      bytes: new ArrayBuffer(4),
      model: "gpt-4o-mini",
      apiKey: "k",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      fetch: fakeFetch,
    });

    expect(out).toBe("portrait");
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(capturedBody).not.toHaveProperty("reasoning");
  });

  test("throws on API error response", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
      })) as unknown as typeof fetch;

    expect(
      classifyPhoto({
        bytes: new ArrayBuffer(4),
        model: "m",
        apiKey: "k",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow();
  });
});

describe("parsePassportJson", () => {
  test("parses a full passport JSON object", () => {
    const out = parsePassportJson(
      '{"family_name":"IVANOVA","given_name":"SOFIA","passport_number":"71 1234567","passport_expiry":"18.04.2029"}',
    );
    expect(out).toEqual({
      family_name: "IVANOVA",
      given_name: "SOFIA",
      passport_number: "71 1234567",
      passport_expiry: "18.04.2029",
    });
  });

  test("strips markdown fences and think tags", () => {
    const out = parsePassportJson(
      '<think>looking at MRZ</think>```json\n{"given_name":"SOFIA"}\n```',
    );
    expect(out).toEqual({ given_name: "SOFIA" });
  });

  test("keeps only known fields and trims values", () => {
    const out = parsePassportJson('{"given_name":"  SOFIA  ","junk":"x","age":"22"}');
    expect(out).toEqual({ given_name: "SOFIA" });
  });

  test("parses the extended passport fields", () => {
    const out = parsePassportJson(
      '{"date_of_birth":"12.04.1998","nationality":"Russia","place_of_birth":"MOSCOW"}',
    );
    expect(out).toEqual({
      date_of_birth: "12.04.1998",
      nationality: "Russia",
      place_of_birth: "MOSCOW",
    });
  });

  test("returns empty object on garbage or empty input", () => {
    expect(parsePassportJson("не вижу паспорт")).toEqual({});
    expect(parsePassportJson("")).toEqual({});
    expect(parsePassportJson("{}")).toEqual({});
    expect(parsePassportJson("[1,2,3]")).toEqual({});
  });
});

describe("parseInternalPassportJson", () => {
  test("parses the internal-passport fields", () => {
    const out = parseInternalPassportJson(
      '{"national_id_number":"12 34 567890","date_of_birth":"12.04.1998","place_of_birth":"г. МОСКВА"}',
    );
    expect(out).toEqual({
      national_id_number: "12 34 567890",
      date_of_birth: "12.04.1998",
      place_of_birth: "г. МОСКВА",
    });
  });

  test("keeps only known fields and trims", () => {
    const out = parseInternalPassportJson(
      '<think>x</think>```json\n{"national_id_number":"  12 34 567890 ","junk":"y"}\n```',
    );
    expect(out).toEqual({ national_id_number: "12 34 567890" });
  });

  test("returns empty object on garbage or empty input", () => {
    expect(parseInternalPassportJson("не вижу паспорт")).toEqual({});
    expect(parseInternalPassportJson("{}")).toEqual({});
  });
});

describe("extractInternalPassportIdentity", () => {
  test("posts the image and returns parsed internal-passport fields", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"national_id_number":"12 34 567890"}' } }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const out = await extractInternalPassportIdentity({
      bytes: new TextEncoder().encode("fakeimg").buffer as ArrayBuffer,
      mimeType: "image/png",
      model: "google/gemini-2.5-flash",
      apiKey: "k",
      fetch: fakeFetch,
    });
    expect(out).toEqual({ national_id_number: "12 34 567890" });
  });

  test("throws on API error response", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
      })) as unknown as typeof fetch;

    expect(
      extractInternalPassportIdentity({
        bytes: new ArrayBuffer(4),
        model: "m",
        apiKey: "k",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow();
  });
});

describe("extractPassportIdentity", () => {
  test("posts the image and returns parsed identity fields", async () => {
    let capturedBody: { messages: Array<{ content: unknown }> } | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"family_name":"IVANOVA","given_name":"SOFIA"}',
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const out = await extractPassportIdentity({
      bytes: new TextEncoder().encode("fakeimg").buffer as ArrayBuffer,
      mimeType: "image/png",
      model: "google/gemini-2.5-flash",
      apiKey: "k",
      fetch: fakeFetch,
    });

    expect(out).toEqual({ family_name: "IVANOVA", given_name: "SOFIA" });
    const content = capturedBody?.messages[1]?.content as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content[1]?.image_url?.url).toStartWith("data:image/png;base64,");
  });

  test("returns empty object when the model sees nothing readable", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const out = await extractPassportIdentity({
      bytes: new ArrayBuffer(4),
      model: "m",
      apiKey: "k",
      fetch: fakeFetch,
    });
    expect(out).toEqual({});
  });

  test("throws on API error response", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
      })) as unknown as typeof fetch;

    expect(
      extractPassportIdentity({
        bytes: new ArrayBuffer(4),
        model: "m",
        apiKey: "k",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow();
  });
});
