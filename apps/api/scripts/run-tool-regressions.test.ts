import { afterEach, describe, expect, test } from "bun:test";
import { runToolCallRegressionCases } from "@chatman-media/kb";
import {
	loadRegressionCorpus,
	main,
	parseArgs,
	renderToolRegressionMarkdown,
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

	test("parses space-separated option forms and repeated --tool", () => {
		const args = parseArgs(
			[
				"--api-base",
				"http://api.test",
				"--token-env",
				"MY_TOKEN",
				"--status",
				"archived",
				"--limit",
				"9",
				"--tool",
				"a",
				"--tool=b",
				"--tools",
				"c,d",
				"--tools=d,e",
				"--token-env=MY_TOKEN",
			],
			{ MY_TOKEN: "tok" },
		);
		expect("error" in args).toBe(false);
		if ("error" in args) return;
		expect(args.source).toEqual({
			kind: "api",
			apiBase: "http://api.test",
			token: "tok",
			status: "archived",
			limit: 9,
		});
		expect(args.supportedTools).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("each option missing its value or invalid → error", () => {
		const cases: Array<[string[], string]> = [
			[["--out-json"], "--out-json requires a path"],
			[["--out-junit"], "--out-junit requires a path"],
			[["--out-md"], "--out-md requires a path"],
			[["--file"], "--file requires a path"],
			[["--api-base"], "--api-base requires a URL"],
			[["--token"], "--token requires a bearer token"],
			[["--token-env"], "--token-env requires an environment variable name"],
			[["--status"], "--status requires active, archived, or all"],
			[
				["--status", "weird"],
				"--status must be active, archived, or all",
			],
			[["--limit"], "--limit requires a number"],
			[["--limit", "abc"], "--limit must be an integer from 1 to 1000"],
			[["--limit=1001"], "--limit must be an integer from 1 to 1000"],
			[["--tool"], "--tool requires a name"],
			[["--tools"], "--tools requires a comma-separated list"],
			[["--bogus"], "unknown argument: --bogus"],
		];
		for (const [argv, error] of cases) {
			expect(parseArgs(argv, {})).toEqual({ error });
		}
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

describe("renderToolRegressionMarkdown branches", () => {
	test("no failures → 'No regression failures.'", () => {
		const report = runToolCallRegressionCases({
			raw: jsonl(validRecord({ id: 1 })),
		});
		const md = renderToolRegressionMarkdown(report);
		expect(md).toContain("| Failed | 0 |");
		expect(md).toContain("No regression failures.");
	});

	test("more than 20 failures → omission note", () => {
		const records = Array.from({ length: 21 }, (_, index) =>
			validRecord({ id: index + 1, expected: {} }),
		);
		const report = runToolCallRegressionCases({ raw: jsonl(...records) });
		expect(report.summary.failed).toBe(21);
		const md = renderToolRegressionMarkdown(report);
		expect(md).toContain("### Failures");
		expect(md).toContain("- 1 more failed cases omitted from summary.");
	});
});

describe("main()", () => {
	async function runMain(argv: string[]): Promise<{
		logs: string[];
		errors: string[];
		exitCode: number | undefined;
	}> {
		const logs: string[] = [];
		const errors: string[] = [];
		const bunWithArgv = Bun as unknown as { argv: string[] };
		const originalArgv = bunWithArgv.argv;
		const originalLog = console.log;
		const originalError = console.error;
		const originalExitCode = process.exitCode;
		bunWithArgv.argv = ["bun", "run-tool-regressions.ts", ...argv];
		console.log = (...parts: unknown[]) => {
			logs.push(parts.join(" "));
		};
		console.error = (...parts: unknown[]) => {
			errors.push(parts.join(" "));
		};
		process.exitCode = 0;
		try {
			await main();
			const exitCode = process.exitCode;
			return { logs, errors, exitCode };
		} finally {
			console.log = originalLog;
			console.error = originalError;
			bunWithArgv.argv = originalArgv;
			process.exitCode = originalExitCode;
		}
	}

	test("invalid argument → help on stdout, error on stderr, exitCode 1", async () => {
		const { logs, errors, exitCode } = await runMain(["--bogus"]);
		expect(errors[0]).toBe("unknown argument: --bogus");
		expect(logs.join("\n")).toContain("Usage:");
		expect(exitCode).toBe(1);
	});

	test("--help → usage, exitCode stays 0", async () => {
		const { logs, exitCode } = await runMain(["--help"]);
		expect(logs.join("\n")).toContain("Usage:");
		expect(exitCode).toBe(0);
	});

	test("file corpus with failures → summary, failure details, exitCode 1, reports written", async () => {
		const corpusFile = `/tmp/tool-regression-main-${crypto.randomUUID()}.jsonl`;
		const outputDir = `/tmp/tool-regression-main-out-${crypto.randomUUID()}`;
		await Bun.write(
			corpusFile,
			jsonl(
				validRecord({ id: 1 }),
				validRecord({ id: 2, status: "archived" }),
				validRecord({ id: 3, expected: {} }),
			),
		);

		const { logs, errors, exitCode } = await runMain([
			"--file",
			corpusFile,
			"--out-md",
			`${outputDir}/report.md`,
		]);

		const stdout = logs.join("\n");
		expect(stdout).toContain("Tool-call regression cases:");
		expect(stdout).toContain("total=3");
		expect(stdout).toContain("failed=1");
		expect(stdout).toContain("Skipped:");
		expect(errors.join("\n")).toContain("Failures:");
		expect(exitCode).toBe(1);
		const md = await Bun.file(`${outputDir}/report.md`).text();
		expect(md).toContain("| Failed | 1 |");
	});

	test("--json with passing corpus → machine-readable report, exitCode 0", async () => {
		const corpusFile = `/tmp/tool-regression-json-${crypto.randomUUID()}.jsonl`;
		await Bun.write(corpusFile, jsonl(validRecord({ id: 1 })));

		const { logs, errors, exitCode } = await runMain([
			"--file",
			corpusFile,
			"--json",
		]);

		expect(errors).toEqual([]);
		expect(exitCode).toBe(0);
		const report = JSON.parse(logs.join("\n")) as {
			summary: { total: number; passed: number };
		};
		expect(report.summary).toEqual(
			expect.objectContaining({ total: 1, passed: 1 }),
		);
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
