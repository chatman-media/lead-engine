import { afterEach, describe, expect, test } from "bun:test";
import { runToolCallRegressionCases } from "@chatman-media/kb";
import {
	loadRegressionCorpus,
	parseArgs,
	writeReportOutputs,
} from "./run-tool-regressions.ts";

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

	test("parses report output paths", () => {
		const args = parseArgs([
			"--file=cases.jsonl",
			"--out-json=artifacts/report.json",
			"--out-junit=artifacts/report.xml",
			"--out-md=artifacts/report.md",
		]);

		expect("error" in args).toBe(false);
		if ("error" in args) return;
		expect(args.outJsonPath?.endsWith("/artifacts/report.json")).toBe(true);
		expect(args.outJunitPath?.endsWith("/artifacts/report.xml")).toBe(true);
		expect(args.outMdPath?.endsWith("/artifacts/report.md")).toBe(true);
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

	test("writes JSON, JUnit, and Markdown report outputs", async () => {
		const outputDir = `/tmp/tool-regression-reports-${crypto.randomUUID()}`;
		const escapedToolName = "quote<&>\"'tool";
		const report = runToolCallRegressionCases({
			raw: jsonl(
				validRecord({
					id: 1,
					toolName: escapedToolName,
					input: {
						source: "rag_reply",
						toolName: escapedToolName,
						args: { quoteId: "q1" },
						feedback: { label: "bad_args", note: null },
					},
				}),
				validRecord({ id: 2, status: "archived", expected: {} }),
				validRecord({ id: 3, expected: {} }),
			),
		});
		const args = parseArgs([
			"--file=cases.jsonl",
			"--out-json",
			`${outputDir}/report.json`,
			"--out-junit",
			`${outputDir}/report.xml`,
			"--out-md",
			`${outputDir}/report.md`,
		]);
		expect("error" in args).toBe(false);
		if ("error" in args) return;

		await writeReportOutputs(report, args);

		const json = JSON.parse(
			await Bun.file(`${outputDir}/report.json`).text(),
		) as {
			summary: { passed: number; failed: number; skipped: number };
		};
		const junit = await Bun.file(`${outputDir}/report.xml`).text();
		const md = await Bun.file(`${outputDir}/report.md`).text();

		expect(json.summary).toEqual(
			expect.objectContaining({ passed: 1, failed: 1, skipped: 1 }),
		);
		expect(junit).toContain(
			'<testsuite name="tool-call-regressions" tests="3" failures="1" skipped="1"',
		);
		expect(junit).toContain("quote&lt;&amp;&gt;&quot;&apos;tool");
		expect(junit).toContain("<skipped");
		expect(junit).toContain("<failure");
		expect(md).toContain("| Failed | 1 |");
		expect(md).toContain("expected.behavior");
	});
});

function validRecord(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		recordType: "tool_call_regression_case",
		id: 17,
		proposalId: 5,
		toolCallId: 11,
		source: "tool_call_feedback",
		toolName: "create_exchange_order",
		label: "bad_args",
		title: "REG: order requires verified quote",
		input: {
			source: "rag_reply",
			toolName: "create_exchange_order",
			args: { quoteId: "q1" },
			feedback: { label: "bad_args", note: "accepted an unverified quote" },
		},
		expected: {
			behavior:
				"The agent must require a verified quote before order creation.",
			proposalKind: "schema_fix",
			actionItems: ["Reject unverified quote IDs."],
		},
		context: {
			toolCall: {
				id: 11,
				result: { orderId: "ord_1" },
				error: false,
				cycle: 0,
				toolCallIndex: 0,
				latencyMs: 42,
			},
		},
		status: "active",
		createdByAdminId: 3,
		createdAt: 1781077061,
		updatedAt: 1781077061,
		...over,
	};
}

function jsonl(...records: Record<string, unknown>[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
