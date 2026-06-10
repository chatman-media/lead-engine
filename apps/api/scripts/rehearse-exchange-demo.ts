#!/usr/bin/env bun
/**
 * Rehearse the exchange demo against a running apps/api server.
 *
 * Prerequisites:
 *   1. Seed the demo tenant:
 *      DATABASE_URL=... PLATFORM_MASTER_KEY=... bun run --cwd apps/api seed:exchange-demo
 *   2. Start apps/api:
 *      DATABASE_URL=... PLATFORM_MASTER_KEY=... bun run dev
 *   3. Run this script:
 *      EXCHANGE_DEMO_PASSWORD=... bun run --cwd apps/api rehearse:exchange-demo
 */

const DEFAULT_API_BASE = "http://127.0.0.1:3000";
const DEFAULT_EMAIL = "owner@exchange.demo";
const DEFAULT_RUNS = 2;
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_PERSONA_IDS = [
	"exchange_rub",
	"exchange_usdt",
	"exchange_atm_cardless",
	"exchange_thai_bank",
];

interface Args {
	apiBase: string;
	email: string;
	loginPassword: string;
	runs: number;
	maxTurns: number;
	personaIds: string[];
	allowFailures: boolean;
}

interface LoginResponse {
	token?: string;
	error?: string;
}

interface ExchangeEvalReportRow {
	id: string;
	displayName: string;
	passed?: boolean;
	reasons?: string[];
	error?: string;
	signals?: Record<string, unknown>;
}

interface ExchangeEvalResponse {
	summary?: { passed: number; total: number };
	report?: ExchangeEvalReportRow[];
	error?: string;
}

function parsePositiveInt(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function parseArgs(): Args {
	const out: Args = {
		apiBase: process.env.EXCHANGE_DEMO_API_BASE ?? DEFAULT_API_BASE,
		email: process.env.EXCHANGE_DEMO_OWNER_EMAIL ?? DEFAULT_EMAIL,
		loginPassword: process.env.EXCHANGE_DEMO_PASSWORD ?? "test1234",
		runs: Number(process.env.EXCHANGE_DEMO_REHEARSAL_RUNS ?? DEFAULT_RUNS),
		maxTurns: Number(
			process.env.EXCHANGE_DEMO_REHEARSAL_MAX_TURNS ?? DEFAULT_MAX_TURNS,
		),
		personaIds: (
			process.env.EXCHANGE_DEMO_REHEARSAL_PERSONAS?.split(",") ??
			DEFAULT_PERSONA_IDS
		)
			.map((item) => item.trim())
			.filter(Boolean),
		allowFailures: process.env.EXCHANGE_DEMO_REHEARSAL_ALLOW_FAILURES === "1",
	};

	for (const arg of process.argv.slice(2)) {
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--allow-failures") {
			out.allowFailures = true;
			continue;
		}
		const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
		const value = rest.join("=");
		if (!rawKey || value === undefined) continue;
		if (rawKey === "api-base") out.apiBase = value;
		else if (rawKey === "email") out.email = value;
		else if (rawKey === "password") out.loginPassword = value;
		else if (rawKey === "runs") out.runs = parsePositiveInt(value, "--runs");
		else if (rawKey === "max-turns")
			out.maxTurns = parsePositiveInt(value, "--max-turns");
		else if (rawKey === "persona-ids")
			out.personaIds = value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
	}

	out.apiBase = out.apiBase.replace(/\/+$/, "");
	if (!out.email.trim()) throw new Error("email is required");
	if (!out.loginPassword) throw new Error("password is required");
	if (!Number.isInteger(out.runs) || out.runs < 1)
		throw new Error("runs must be a positive integer");
	if (!Number.isInteger(out.maxTurns) || out.maxTurns < 1)
		throw new Error("maxTurns must be a positive integer");
	if (out.personaIds.length === 0)
		throw new Error("at least one persona id is required");
	return out;
}

function printHelp(): void {
	console.log(`Exchange demo rehearsal

Usage:
  bun run --cwd apps/api rehearse:exchange-demo [options]

Options:
  --api-base=http://127.0.0.1:3000
  --email=owner@exchange.demo
  --password=<admin-password>
  --runs=2
  --max-turns=8
  --persona-ids=exchange_rub,exchange_usdt,exchange_atm_cardless,exchange_thai_bank
  --allow-failures

Env:
  EXCHANGE_DEMO_API_BASE
  EXCHANGE_DEMO_OWNER_EMAIL
  EXCHANGE_DEMO_PASSWORD
  EXCHANGE_DEMO_REHEARSAL_RUNS
  EXCHANGE_DEMO_REHEARSAL_MAX_TURNS
  EXCHANGE_DEMO_REHEARSAL_PERSONAS
  EXCHANGE_DEMO_REHEARSAL_ALLOW_FAILURES=1
`);
}

async function postJson<T>(
	url: string,
	body: Record<string, unknown>,
	token?: string,
): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const parsed = text ? (JSON.parse(text) as T) : ({} as T);
	if (!response.ok) {
		const message =
			typeof (parsed as { error?: unknown }).error === "string"
				? (parsed as { error: string }).error
				: `HTTP ${response.status}`;
		throw new Error(message);
	}
	return parsed;
}

async function login(args: Args): Promise<string> {
	const body = await postJson<LoginResponse>(`${args.apiBase}/api/auth/login`, {
		email: args.email,
		password: args.loginPassword,
	});
	if (!body.token) throw new Error(body.error ?? "login did not return token");
	return body.token;
}

function printRunResult(run: number, body: ExchangeEvalResponse): boolean {
	if (!body.summary || !Array.isArray(body.report)) {
		throw new Error(body.error ?? "exchange-eval returned malformed response");
	}
	const passed = body.summary.passed === body.summary.total;
	console.log(
		`[rehearse-exchange-demo] run ${run}: ${body.summary.passed}/${body.summary.total} passed`,
	);
	for (const row of body.report) {
		const status = row.passed === true ? "PASS" : "FAIL";
		const reasons =
			row.reasons && row.reasons.length > 0
				? ` - ${row.reasons.join("; ")}`
				: "";
		const error = row.error ? ` - ${row.error}` : "";
		console.log(`  ${status} ${row.id} (${row.displayName})${reasons}${error}`);
	}
	return passed;
}

async function main() {
	const args = parseArgs();
	const token = await login(args);
	let failedRuns = 0;

	for (let run = 1; run <= args.runs; run++) {
		const body = await postJson<ExchangeEvalResponse>(
			`${args.apiBase}/api/admin/sim/exchange-eval`,
			{
				maxTurns: args.maxTurns,
				personaIds: args.personaIds,
			},
			token,
		);
		if (!printRunResult(run, body)) failedRuns++;
	}

	if (failedRuns > 0 && !args.allowFailures) {
		throw new Error(`${failedRuns}/${args.runs} rehearsal run(s) failed`);
	}
	console.log("[rehearse-exchange-demo] done");
}

main().catch((err) => {
	console.error(
		"[rehearse-exchange-demo] FAILED:",
		err instanceof Error ? err.message : err,
	);
	process.exit(1);
});
