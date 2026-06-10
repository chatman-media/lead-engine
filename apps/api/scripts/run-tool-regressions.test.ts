import { afterEach, describe, expect, test } from "bun:test";
import { loadRegressionCorpus, parseArgs } from "./run-tool-regressions.ts";

const servers: Bun.Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

describe("run-tool-regressions CLI source handling", () => {
	test("parses API mode with token from env and filter options", () => {
		const args = parseArgs(
			[
				"--api-base=http://api.test",
				"--status=all",
				"--limit=25",
				"--tools=offer_booking_link,create_exchange_order",
				"--skip-unsupported",
			],
			{ QUALITY_LAB_TOKEN: "secret-token" },
		);

		expect("error" in args).toBe(false);
		if ("error" in args) return;
		expect(args.source).toEqual({
			kind: "api",
			apiBase: "http://api.test",
			token: "secret-token",
			status: "all",
			limit: 25,
		});
		expect(args.supportedTools).toEqual([
			"offer_booking_link",
			"create_exchange_order",
		]);
		expect(args.skipUnsupported).toBe(true);
	});

	test("rejects ambiguous and invalid API arguments", () => {
		expect(parseArgs(["--api-base=http://api.test"], {})).toEqual({
			error: "--api-base requires --token or QUALITY_LAB_TOKEN",
		});
		expect(
			parseArgs([
				"--file=cases.jsonl",
				"--api-base=http://api.test",
				"--token=x",
			]),
		).toEqual({
			error: "--file and --api-base cannot be used together",
		});
		expect(
			parseArgs(["--api-base=http://api.test", "--token=x", "--status=bad"]),
		).toEqual({
			error: "--status must be active, archived, or all",
		});
		expect(
			parseArgs(["--api-base=http://api.test", "--token=x", "--limit=0"]),
		).toEqual({
			error: "--limit must be an integer from 1 to 1000",
		});
		expect(parseArgs(["--api-base=not-a-url", "--token=x"])).toEqual({
			error: "--api-base must be a valid URL",
		});
	});

	test("loads local file corpus with metadata", async () => {
		const tempFile = `/tmp/tool-regression-${crypto.randomUUID()}.jsonl`;
		await Bun.write(tempFile, "# empty corpus is valid\n");

		const args = parseArgs(["--file", tempFile]);
		expect("error" in args).toBe(false);
		if ("error" in args) return;

		const corpus = await loadRegressionCorpus(args);
		expect(corpus.raw).toBe("# empty corpus is valid\n");
		expect(corpus.metadata).toEqual({ source: "file", filePath: tempFile });
	});

	test("fetches API corpus with bearer auth and query filters", async () => {
		const seen: {
			auth?: string;
			status?: string | null;
			limit?: string | null;
		} = {};
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				seen.auth = req.headers.get("authorization") ?? undefined;
				seen.status = url.searchParams.get("status");
				seen.limit = url.searchParams.get("limit");
				return new Response("# fetched\n", {
					headers: { "Content-Type": "application/x-ndjson" },
				});
			},
		});
		servers.push(server);

		const args = parseArgs([
			"--api-base",
			server.url.toString(),
			"--token",
			"secret",
			"--status=archived",
			"--limit=7",
		]);
		expect("error" in args).toBe(false);
		if ("error" in args) return;

		const corpus = await loadRegressionCorpus(args);
		expect(corpus.raw).toBe("# fetched\n");
		expect(corpus.metadata).toEqual({
			source: "api",
			apiBase: server.url.toString().replace(/\/$/, ""),
			status: "archived",
			limit: 7,
		});
		expect(seen).toEqual({
			auth: "Bearer secret",
			status: "archived",
			limit: "7",
		});
	});

	test("reports API HTTP failures with status and body", async () => {
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
				});
			},
		});
		servers.push(server);

		const args = parseArgs([
			"--api-base",
			server.url.toString(),
			"--token",
			"bad",
		]);
		expect("error" in args).toBe(false);
		if ("error" in args) return;

		await expect(loadRegressionCorpus(args)).rejects.toThrow(
			"Quality API export failed: 401",
		);
		await expect(loadRegressionCorpus(args)).rejects.toThrow("unauthorized");
	});
});
