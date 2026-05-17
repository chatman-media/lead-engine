import { describe, expect, test } from "bun:test";

import {
  classifyPhoto,
  extractPassportIdentity,
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

  test("returns empty object on garbage or empty input", () => {
    expect(parsePassportJson("не вижу паспорт")).toEqual({});
    expect(parsePassportJson("")).toEqual({});
    expect(parsePassportJson("{}")).toEqual({});
    expect(parsePassportJson("[1,2,3]")).toEqual({});
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
