#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseExchangeGoldenJsonl } from "../src/lib/exchange/golden-eval.ts";
import {
	formatExchangeSelfPlayScenarioReport,
	runExchangeSelfPlayScenarioCorpus,
} from "../src/lib/exchange/scenario-corpus.ts";

interface Args {
	fixturesPath: string;
	json: boolean;
	scenarioId?: string;
}

function usage(): string {
	return [
		"Usage: bun run scripts/eval-exchange-corpus.ts [--scenario=<id>] [--fixtures=<path>] [--json]",
		"",
		"Checks the deterministic exchange self-play scenario corpus.",
		"By default it also validates sourceFixtureId links against apps/vertical-exchange/evals/exchange-workflows.jsonl.",
	].join("\n");
}

function parseArgs(argv: readonly string[]): Args {
	const defaults: Args = {
		fixturesPath: resolve(
			import.meta.dir,
			"..",
			"..",
			"vertical-exchange",
			"evals",
			"exchange-workflows.jsonl",
		),
		json: false,
	};
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			console.log(usage());
			process.exit(0);
		}
		if (arg === "--json") {
			defaults.json = true;
			continue;
		}
		if (arg.startsWith("--scenario=")) {
			defaults.scenarioId = arg.slice("--scenario=".length);
			continue;
		}
		if (arg === "--scenario") {
			throw new Error("Use --scenario=<id>");
		}
		if (arg.startsWith("--fixtures=")) {
			defaults.fixturesPath = resolve(arg.slice("--fixtures=".length));
			continue;
		}
		if (arg === "--fixtures") {
			throw new Error("Use --fixtures=<path>");
		}
		throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
	}
	return defaults;
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const fixtureCases = parseExchangeGoldenJsonl(
		readFileSync(args.fixturesPath, "utf8"),
	);
	const report = runExchangeSelfPlayScenarioCorpus({
		scenarioId: args.scenarioId,
		fixtureCases,
	});

	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatExchangeSelfPlayScenarioReport(report));
	}

	if (!report.ok) process.exit(1);
}

main();
