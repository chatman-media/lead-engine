import { afterEach, describe, expect, it } from "bun:test";
import { OpenRouterTranscriber } from "./openrouter-transcriber.ts";
import { WhisperTranscriber } from "./whisper-transcriber.ts";

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.warn = originalWarn;
});

describe("OpenRouterTranscriber", () => {
	it("posts base64 JSON audio and normalizes oga format", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), init });
			return Response.json({ text: "  hello voice  " });
		}) as typeof fetch;

		const out = await new OpenRouterTranscriber({
			apiKey: "or-key",
			baseUrl: "https://openrouter.test/api/v1/",
			model: "google/chirp",
			timeoutMs: 1234,
		}).transcribe(new Uint8Array([1, 2, 3]), "voice.oga");

		expect(out).toBe("hello voice");
		const call = calls.at(0);
		if (!call) throw new Error("fetch was not called");
		expect(call.url).toBe(
			"https://openrouter.test/api/v1/audio/transcriptions",
		);
		expect(call.init?.headers).toMatchObject({
			"content-type": "application/json",
			authorization: "Bearer or-key",
		});
		expect(JSON.parse(String(call.init?.body))).toEqual({
			model: "google/chirp",
			input_audio: { data: "AQID", format: "ogg" },
		});
	});

	it("returns null on fetch, API and response parsing failures", async () => {
		const warns: string[] = [];
		console.warn = (msg: string) => warns.push(msg);
		const transcriber = new OpenRouterTranscriber({ apiKey: "or-key" });

		globalThis.fetch = (async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(
			await transcriber.transcribe(new Uint8Array([1]), "a.ogg"),
		).toBeNull();

		globalThis.fetch = (async () =>
			new Response("bad", { status: 500 })) as unknown as typeof fetch;
		expect(
			await transcriber.transcribe(new Uint8Array([1]), "a.ogg"),
		).toBeNull();

		globalThis.fetch = (async () =>
			new Response("not json", { status: 200 })) as unknown as typeof fetch;
		expect(
			await transcriber.transcribe(new Uint8Array([1]), "a.ogg"),
		).toBeNull();
		expect(warns.length).toBeGreaterThanOrEqual(3);
	});
});

describe("WhisperTranscriber", () => {
	it("posts multipart audio and trims text response", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response("  hello whisper  ");
		}) as typeof fetch;

		const out = await new WhisperTranscriber({
			apiKey: "openai-key",
			baseUrl: "https://openai.test/v1",
			model: "whisper-test",
		}).transcribe(new Uint8Array([4, 5, 6]), "voice.ogg");

		expect(out).toBe("hello whisper");
		const call = calls.at(0);
		if (!call) throw new Error("fetch was not called");
		expect(call.url).toBe("https://openai.test/v1/audio/transcriptions");
		expect(call.init?.headers).toMatchObject({
			Authorization: "Bearer openai-key",
		});
		const form = call.init?.body;
		expect(form).toBeInstanceOf(FormData);
		if (!(form instanceof FormData)) throw new Error("body is not FormData");
		expect(form.get("model")).toBe("whisper-test");
		expect(form.get("response_format")).toBe("text");
		expect(form.get("file")).toBeInstanceOf(Blob);
	});

	it("returns null on network errors, API errors and empty text", async () => {
		const warns: string[] = [];
		console.warn = (msg: string) => warns.push(msg);
		const transcriber = new WhisperTranscriber({ apiKey: "openai-key" });

		globalThis.fetch = (async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(
			await transcriber.transcribe(new Uint8Array([1]), "a.ogg"),
		).toBeNull();

		globalThis.fetch = (async () =>
			new Response("bad", { status: 400 })) as unknown as typeof fetch;
		expect(
			await transcriber.transcribe(new Uint8Array([1]), "a.ogg"),
		).toBeNull();

		globalThis.fetch = (async () =>
			new Response("   ")) as unknown as typeof fetch;
		expect(
			await transcriber.transcribe(new Uint8Array([1]), "a.ogg"),
		).toBeNull();
		expect(warns.length).toBeGreaterThanOrEqual(2);
	});
});
