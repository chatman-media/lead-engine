import { describe, expect, test } from "bun:test";

import { classifyPhoto, parsePhotoClass } from "@/rag/vision.ts";

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
