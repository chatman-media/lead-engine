#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	formatToolCallRegressionFailures,
	runToolCallRegressionCases,
	type ToolCallRegressionReport,
	toolCallRegressionExitCode,
} from "@chatman-media/kb";

type ApiStatus = "active" | "archived" | "all";

interface FileCorpusSource {
	kind: "file";
	filePath: string;
}

interface ApiCorpusSource {
	kind: "api";
	apiBase: string;
	token: string;
	status: ApiStatus;
	limit: number;
}

export type CorpusSource = FileCorpusSource | ApiCorpusSource;

export interface CliArgs {
	source: CorpusSource;
	supportedTools: string[];
	includeArchived: boolean;
	skipUnsupported: boolean;
	json: boolean;
	outJsonPath?: string;
	outJunitPath?: string;
	outMdPath?: string;
	help: boolean;
}

export interface LoadedRegressionCorpus {
	raw: string;
	metadata: Record<string, unknown>;
}

const defaultFilePath = resolve("tool-call-regression-cases.jsonl");
const defaultApiLimit = 500;
const maxApiLimit = 1000;
const defaultTokenEnv = "QUALITY_LAB_TOKEN";

export function parseArgs(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): CliArgs | { error: string } {
	const args = {
		supportedTools: [] as string[],
		includeArchived: false,
		skipUnsupported: false,
		json: false,
		help: false,
	};
	let outJsonPath: string | undefined;
	let outJunitPath: string | undefined;
	let outMdPath: string | undefined;
	let filePath = defaultFilePath;
	let fileExplicit = false;
	let apiBase: string | undefined;
	let token: string | undefined;
	let tokenEnv = defaultTokenEnv;
	let status: ApiStatus = "active";
	let limit = defaultApiLimit;

	for (let index = 0; index < argv.length; index += 1) {
		const raw = argv[index];
		if (!raw) continue;

		if (raw === "--help" || raw === "-h") args.help = true;
		else if (raw === "--json") args.json = true;
		else if (raw === "--out-json") {
			const next = argv[index + 1];
			if (!next) return { error: "--out-json requires a path" };
			outJsonPath = resolve(next);
			index += 1;
		} else if (raw.startsWith("--out-json=")) {
			outJsonPath = resolve(raw.slice("--out-json=".length));
		} else if (raw === "--out-junit") {
			const next = argv[index + 1];
			if (!next) return { error: "--out-junit requires a path" };
			outJunitPath = resolve(next);
			index += 1;
		} else if (raw.startsWith("--out-junit=")) {
			outJunitPath = resolve(raw.slice("--out-junit=".length));
		} else if (raw === "--out-md") {
			const next = argv[index + 1];
			if (!next) return { error: "--out-md requires a path" };
			outMdPath = resolve(next);
			index += 1;
		} else if (raw.startsWith("--out-md=")) {
			outMdPath = resolve(raw.slice("--out-md=".length));
		} else if (raw === "--include-archived") args.includeArchived = true;
		else if (raw === "--skip-unsupported") args.skipUnsupported = true;
		else if (raw === "--file") {
			const next = argv[index + 1];
			if (!next) return { error: "--file requires a path" };
			filePath = resolve(next);
			fileExplicit = true;
			index += 1;
		} else if (raw.startsWith("--file=")) {
			filePath = resolve(raw.slice("--file=".length));
			fileExplicit = true;
		} else if (raw === "--api-base") {
			const next = argv[index + 1];
			if (!next) return { error: "--api-base requires a URL" };
			apiBase = next;
			index += 1;
		} else if (raw.startsWith("--api-base=")) {
			apiBase = raw.slice("--api-base=".length);
		} else if (raw === "--token") {
			const next = argv[index + 1];
			if (!next) return { error: "--token requires a bearer token" };
			token = next;
			index += 1;
		} else if (raw.startsWith("--token=")) {
			token = raw.slice("--token=".length);
		} else if (raw === "--token-env") {
			const next = argv[index + 1];
			if (!next)
				return { error: "--token-env requires an environment variable name" };
			tokenEnv = next;
			index += 1;
		} else if (raw.startsWith("--token-env=")) {
			tokenEnv = raw.slice("--token-env=".length);
		} else if (raw === "--status") {
			const next = argv[index + 1];
			if (!next) return { error: "--status requires active, archived, or all" };
			const parsed = parseApiStatus(next);
			if (!parsed)
				return { error: "--status must be active, archived, or all" };
			status = parsed;
			index += 1;
		} else if (raw.startsWith("--status=")) {
			const parsed = parseApiStatus(raw.slice("--status=".length));
			if (!parsed)
				return { error: "--status must be active, archived, or all" };
			status = parsed;
		} else if (raw === "--limit") {
			const next = argv[index + 1];
			if (!next) return { error: "--limit requires a number" };
			const parsed = parseApiLimit(next);
			if ("error" in parsed) return parsed;
			limit = parsed.limit;
			index += 1;
		} else if (raw.startsWith("--limit=")) {
			const parsed = parseApiLimit(raw.slice("--limit=".length));
			if ("error" in parsed) return parsed;
			limit = parsed.limit;
		} else if (raw === "--tool") {
			const next = argv[index + 1];
			if (!next) return { error: "--tool requires a name" };
			addTools(args.supportedTools, next);
			index += 1;
		} else if (raw.startsWith("--tool=")) {
			addTools(args.supportedTools, raw.slice("--tool=".length));
		} else if (raw === "--tools") {
			const next = argv[index + 1];
			if (!next) return { error: "--tools requires a comma-separated list" };
			addTools(args.supportedTools, next);
			index += 1;
		} else if (raw.startsWith("--tools=")) {
			addTools(args.supportedTools, raw.slice("--tools=".length));
		} else {
			return { error: `unknown argument: ${raw}` };
		}
	}

	const outputArgs = { outJsonPath, outJunitPath, outMdPath };
	if (args.help)
		return { ...args, ...outputArgs, source: { kind: "file", filePath } };
	if (!apiBase)
		return { ...args, ...outputArgs, source: { kind: "file", filePath } };
	if (fileExplicit)
		return { error: "--file and --api-base cannot be used together" };
	if (!isValidUrl(apiBase)) return { error: "--api-base must be a valid URL" };

	const resolvedToken = token ?? env[tokenEnv];
	if (!resolvedToken)
		return { error: `--api-base requires --token or ${tokenEnv}` };

	return {
		...args,
		...outputArgs,
		source: {
			kind: "api",
			apiBase,
			token: resolvedToken,
			status,
			limit,
		},
	};
}

function addTools(tools: string[], raw: string) {
	for (const tool of raw
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)) {
		if (!tools.includes(tool)) tools.push(tool);
	}
}

function printHelp() {
	console.log(`Usage:
  bun run quality:tool-regressions -- --file tool-call-regression-cases.jsonl [options]
  bun run quality:tool-regressions -- --api-base http://localhost:3000 --token <token> [options]

Options:
  --file <path>             JSONL export from Quality Lab. Default: ./tool-call-regression-cases.jsonl
  --api-base <url>          Fetch JSONL from /api/admin/quality/tool-call-regression-cases/export.jsonl
  --token <token>           Bearer token for --api-base.
  --token-env <name>        Env var for API token. Default: ${defaultTokenEnv}.
  --status <value>          API export status: active, archived, or all. Default: active.
  --limit <n>               API export limit, 1-${maxApiLimit}. Default: ${defaultApiLimit}.
  --out-json <path>         Write the JSON report to a file.
  --out-junit <path>        Write a JUnit XML report for CI test report viewers.
  --out-md <path>           Write a Markdown summary for GitHub Step Summary.
  --tool <name>             Supported tool name. Can be repeated.
  --tools <a,b,c>           Supported tool names as a comma-separated list.
  --include-archived        Validate archived cases too. By default they are skipped and counted.
  --skip-unsupported        Skip cases whose toolName is not in --tool/--tools.
  --json                    Print the full machine-readable report.
  --help                    Show this help.
`);
}

export async function loadRegressionCorpus(
	args: CliArgs,
): Promise<LoadedRegressionCorpus> {
	if (args.source.kind === "file") {
		return {
			raw: await Bun.file(args.source.filePath).text(),
			metadata: {
				source: "file",
				filePath: args.source.filePath,
			},
		};
	}

	const url = buildApiExportUrl(args.source);
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${args.source.token}`,
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			[
				`Quality API export failed: ${res.status} ${res.statusText}`.trim(),
				`url=${redactUrl(url)}`,
				body ? `body=${summarizeText(body)}` : null,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	return {
		raw: await res.text(),
		metadata: {
			source: "api",
			apiBase: normalizeApiBase(args.source.apiBase),
			status: args.source.status,
			limit: args.source.limit,
		},
	};
}

export async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	if ("error" in args) {
		console.error(args.error);
		printHelp();
		process.exitCode = 1;
		return;
	}
	if (args.help) {
		printHelp();
		return;
	}

	const corpus = await loadRegressionCorpus(args);
	const report = runToolCallRegressionCases({
		raw: corpus.raw,
		includeArchived:
			args.includeArchived ||
			(args.source.kind === "api" && args.source.status === "archived"),
		skipUnsupported: args.skipUnsupported,
		supportedTools:
			args.supportedTools.length > 0 ? args.supportedTools : undefined,
		metadata: {
			...corpus.metadata,
			...(args.supportedTools.length > 0
				? { supportedTools: args.supportedTools }
				: {}),
		},
	});

	await writeReportOutputs(report, args);

	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printSummary(report);
		const failures = formatToolCallRegressionFailures(report);
		if (failures) {
			console.error("\nFailures:\n");
			console.error(failures);
		}
	}

	process.exitCode = toolCallRegressionExitCode(report);
}

export async function writeReportOutputs(
	report: ToolCallRegressionReport,
	args: CliArgs,
) {
	if (args.outJsonPath) {
		await writeTextFile(
			args.outJsonPath,
			`${JSON.stringify(report, null, 2)}\n`,
		);
	}
	if (args.outJunitPath) {
		await writeTextFile(args.outJunitPath, renderToolRegressionJunit(report));
	}
	if (args.outMdPath) {
		await writeTextFile(args.outMdPath, renderToolRegressionMarkdown(report));
	}
}

export function renderToolRegressionJunit(
	report: ToolCallRegressionReport,
): string {
	const tests = report.summary.total;
	const failures = report.summary.failed;
	const skipped = report.summary.skipped;
	const cases = report.results.map((result) => {
		const name = [
			`line ${result.line}`,
			result.caseId ? `case ${result.caseId}` : "case unknown",
			result.toolName ?? "tool unknown",
		].join(" - ");
		const attrs = [
			'classname="tool-call-regression"',
			`name="${xmlEscape(name)}"`,
			'time="0"',
		].join(" ");
		if (result.status === "passed") return `    <testcase ${attrs}/>`;
		if (result.status === "skipped") {
			return [
				`    <testcase ${attrs}>`,
				`      <skipped message="${xmlEscape(result.skipReason ?? "skipped")}"/>`,
				"    </testcase>",
			].join("\n");
		}
		const message = `${result.failures.length} validation failure${
			result.failures.length === 1 ? "" : "s"
		}`;
		return [
			`    <testcase ${attrs}>`,
			`      <failure message="${xmlEscape(message)}">`,
			xmlEscape(formatCaseFailures(result.failures))
				.split("\n")
				.map((line) => `        ${line}`)
				.join("\n"),
			"      </failure>",
			"    </testcase>",
		].join("\n");
	});

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuite name="tool-call-regressions" tests="${tests}" failures="${failures}" skipped="${skipped}" time="0">`,
		...cases,
		"</testsuite>",
		"",
	].join("\n");
}

export function renderToolRegressionMarkdown(
	report: ToolCallRegressionReport,
): string {
	const lines = [
		"## Tool-call Regression Report",
		"",
		`Generated: ${report.generatedAt}`,
		"",
		"| Metric | Count |",
		"|---|---:|",
		`| Total | ${report.summary.total} |`,
		`| Passed | ${report.summary.passed} |`,
		`| Failed | ${report.summary.failed} |`,
		`| Skipped | ${report.summary.skipped} |`,
		`| Active | ${report.summary.active} |`,
		`| Archived | ${report.summary.archived} |`,
		`| Unsupported | ${report.summary.unsupported} |`,
		"",
	];

	const skipReasons = Object.entries(report.summary.skipReasons);
	if (skipReasons.length > 0) {
		lines.push("Skipped by reason:", "");
		for (const [reason, count] of skipReasons) {
			lines.push(`- ${reason}: ${count}`);
		}
		lines.push("");
	}

	const failures = report.results.filter(
		(result) => result.status === "failed",
	);
	if (failures.length === 0) {
		lines.push("No regression failures.");
		return `${lines.join("\n")}\n`;
	}

	lines.push("### Failures", "");
	for (const result of failures.slice(0, 20)) {
		lines.push(
			`- line ${result.line}, case ${result.caseId ?? "unknown"}, tool ${
				result.toolName ?? "unknown"
			}`,
		);
		for (const failure of result.failures) {
			lines.push(
				`  - ${failure.path}: expected ${failure.expected}; actual ${failure.actual}`,
			);
		}
	}
	if (failures.length > 20) {
		lines.push(
			`- ${failures.length - 20} more failed cases omitted from summary.`,
		);
	}

	return `${lines.join("\n")}\n`;
}

function printSummary(report: ToolCallRegressionReport) {
	const { summary } = report;
	console.log(
		[
			"Tool-call regression cases:",
			`total=${summary.total}`,
			`passed=${summary.passed}`,
			`failed=${summary.failed}`,
			`skipped=${summary.skipped}`,
		].join(" "),
	);

	const skipReasons = Object.entries(summary.skipReasons);
	if (skipReasons.length > 0) {
		console.log(
			`Skipped: ${skipReasons
				.map(([reason, count]) => `${reason}=${count}`)
				.join(" ")}`,
		);
	}
}

async function writeTextFile(path: string, content: string) {
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, content);
}

function formatCaseFailures(
	failures: ToolCallRegressionReport["results"][number]["failures"],
) {
	return failures
		.map((failure) =>
			[
				`line=${failure.line}`,
				`case=${failure.caseId ?? "unknown"}`,
				`tool=${failure.toolName ?? "unknown"}`,
				`path=${failure.path}`,
				`expected=${failure.expected}`,
				`actual=${failure.actual}`,
			].join("\n"),
		)
		.join("\n\n");
}

function xmlEscape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function parseApiStatus(value: string): ApiStatus | null {
	if (value === "active" || value === "archived" || value === "all")
		return value;
	return null;
}

function parseApiLimit(value: string): { limit: number } | { error: string } {
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > maxApiLimit) {
		return { error: `--limit must be an integer from 1 to ${maxApiLimit}` };
	}
	return { limit };
}

function isValidUrl(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

function buildApiExportUrl(source: ApiCorpusSource): string {
	const url = new URL(
		"/api/admin/quality/tool-call-regression-cases/export.jsonl",
		normalizeApiBase(source.apiBase),
	);
	url.searchParams.set("status", source.status);
	url.searchParams.set("limit", String(source.limit));
	return url.toString();
}

function normalizeApiBase(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function redactUrl(value: string): string {
	const url = new URL(value);
	url.username = "";
	url.password = "";
	return url.toString();
}

function summarizeText(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > 240
		? `${normalized.slice(0, 237)}...`
		: normalized;
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.stack : err);
		process.exitCode = 1;
	});
}
