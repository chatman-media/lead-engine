#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ChatClient,
	type ChatMessage,
	compareRagGoldenReports,
	defaultRagGoldenAblations,
	type EmbeddingClient,
	evaluateRagGoldenCases,
	formatRagGoldenFailures,
	type IKbStore,
	type KbSearchHit,
	parseRagGoldenJsonl,
	type RagGoldenCase,
	type RagGoldenReport,
} from "@chatman-media/kb";

interface CliArgs {
	goldenPath: string;
	baselinePath?: string;
	updateBaselinePath?: string;
	vertical?: string;
	ablate: boolean;
	json: boolean;
	help: boolean;
}

interface FixtureChunk {
	id?: number;
	documentId?: number;
	title: string;
	source: string;
	text: string;
	topic?: string | null;
	distance?: number;
}

interface FixtureRagGoldenCase extends RagGoldenCase {
	kb?: FixtureChunk[];
	mockAnswer?: string;
}

const defaultGoldenPath = fileURLToPath(
	new URL("../../../packages/kb/evals/generic-rag.jsonl", import.meta.url),
);

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		goldenPath: defaultGoldenPath,
		ablate: false,
		json: false,
		help: false,
	};

	for (const raw of argv) {
		if (raw === "--help" || raw === "-h") args.help = true;
		else if (raw === "--ablate") args.ablate = true;
		else if (raw === "--json") args.json = true;
		else if (raw.startsWith("--golden="))
			args.goldenPath = resolve(raw.slice("--golden=".length));
		else if (raw.startsWith("--baseline=")) {
			args.baselinePath = resolve(raw.slice("--baseline=".length));
		} else if (raw === "--update-baseline") {
			args.updateBaselinePath =
				args.baselinePath ??
				resolve("packages/kb/evals/generic-rag.baseline.json");
		} else if (raw.startsWith("--update-baseline=")) {
			args.updateBaselinePath = resolve(raw.slice("--update-baseline=".length));
		} else if (raw.startsWith("--vertical=")) {
			args.vertical = raw.slice("--vertical=".length);
		}
	}

	return args;
}

function printHelp() {
	console.log(`Usage:
  bun run apps/api/scripts/eval-rag.ts [options]

Options:
  --golden=<file>            JSONL golden cases. Default: packages/kb/evals/generic-rag.jsonl
  --baseline=<file>          Compare against a previous JSON report
  --update-baseline[=<file>] Write the current JSON report as a baseline
  --vertical=<slug>          Attach a vertical slug to report metadata
  --ablate                   Run default RAG ablations
  --json                     Print full JSON report
`);
}

const embedder: EmbeddingClient = {
	dim: 3,
	embed: async (inputs) => inputs.map((input) => deterministicVector(input)),
};

function makeChat(item: FixtureRagGoldenCase): ChatClient {
	return {
		complete: async (messages: ChatMessage[]) => {
			const system = messages[0]?.content ?? "";
			if (system.includes("альтернативные формулировки")) {
				return buildQueryVariants(item);
			}
			if (system.includes("переформулируешь вопрос")) {
				return item.question;
			}
			return item.mockAnswer ?? buildMockAnswer(item);
		},
	};
}

class FixtureKbStore implements IKbStore {
	private readonly chunks: Required<FixtureChunk>[];

	constructor(chunks: FixtureChunk[]) {
		this.chunks = chunks.map((chunk, index) => ({
			id: chunk.id ?? index + 1,
			documentId: chunk.documentId ?? index + 1,
			title: chunk.title,
			source: chunk.source,
			text: chunk.text,
			topic: chunk.topic ?? null,
			distance: chunk.distance ?? 0.15 + index * 0.02,
		}));
	}

	async search(
		_embedding: number[],
		k: number,
		topic?: string | null,
	): Promise<KbSearchHit[]> {
		return this.filtered(topic)
			.sort((a, b) => a.distance - b.distance)
			.slice(0, k)
			.map((chunk) => this.toHit(chunk, chunk.distance));
	}

	async hybridSearch(input: {
		embedding: number[];
		query: string;
		k?: number;
		topic?: string | null;
	}): Promise<KbSearchHit[]> {
		const k = input.k ?? 5;
		return this.filtered(input.topic)
			.map((chunk) => {
				const score = keywordScore(
					input.query,
					`${chunk.title} ${chunk.source} ${chunk.text}`,
				);
				return {
					chunk,
					distance: score > 0 ? 1 / (1 + score) : chunk.distance + 0.5,
				};
			})
			.sort((a, b) => a.distance - b.distance)
			.slice(0, k)
			.map(({ chunk, distance }) => this.toHit(chunk, distance));
	}

	async prioritySearch(input: {
		embedding: number[];
		query: string;
		k?: number;
		vectorOnly?: boolean;
	}): Promise<KbSearchHit[]> {
		const books = input.vectorOnly
			? await this.search(input.embedding, input.k ?? 5, "books")
			: await this.hybridSearch({
					embedding: input.embedding,
					query: input.query,
					k: input.k,
					topic: "books",
				});
		if (books.length > 0) return books;
		return input.vectorOnly
			? this.search(input.embedding, input.k ?? 5)
			: this.hybridSearch({
					embedding: input.embedding,
					query: input.query,
					k: input.k,
				});
	}

	async getDocumentBySource(
		_source: string,
	): Promise<{ id: number; content_hash: string } | null> {
		return null;
	}

	async countChunksForDocument(_documentId: number): Promise<number> {
		return 0;
	}

	async deleteDocument(_id: number): Promise<boolean> {
		return false;
	}

	async upsertDocument(_input: {
		source: string;
		title: string;
		contentHash: string;
		topic?: string | null;
	}): Promise<{ id: number }> {
		return { id: 1 };
	}

	async insertChunkWithEmbedding(_input: {
		documentId: number;
		chunkIndex: number;
		text: string;
		tokenCount: number;
		embedding: number[];
	}): Promise<void> {}

	private filtered(topic?: string | null): Required<FixtureChunk>[] {
		if (!topic) return [...this.chunks];
		return this.chunks.filter((chunk) => chunk.topic === topic);
	}

	private toHit(chunk: Required<FixtureChunk>, distance: number): KbSearchHit {
		return {
			chunk_id: chunk.id,
			document_id: chunk.documentId,
			distance,
			title: chunk.title,
			source: chunk.source,
			text: chunk.text,
		};
	}
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	if (args.help) {
		printHelp();
		return;
	}

	const raw = await Bun.file(args.goldenPath).text();
	const cases = parseRagGoldenJsonl(raw) as FixtureRagGoldenCase[];
	const report = await evaluateRagGoldenCases({
		cases,
		makeInput: (item) => {
			const fixture = item as FixtureRagGoldenCase;
			return {
				question: fixture.question,
				history: fixture.history,
				kb: new FixtureKbStore(fixture.kb ?? []),
				embedder,
				chat: makeChat(fixture),
				topK: 5,
				hybridSearch: true,
				topicRouting: true,
				multiQuery: true,
				multiQueryCount: 2,
				mmr: true,
				autoTrimDistance: true,
				autoTrimThreshold: 0.95,
			};
		},
		ablations: args.ablate ? defaultRagGoldenAblations() : undefined,
		metadata: {
			goldenPath: args.goldenPath,
			...(args.vertical ? { vertical: args.vertical } : {}),
		},
	});

	const failures = formatRagGoldenFailures(report);
	const baseline = args.baselinePath
		? await readBaseline(args.baselinePath)
		: null;
	const deltas = baseline ? compareRagGoldenReports(report, baseline) : [];

	if (args.updateBaselinePath) {
		await Bun.write(
			args.updateBaselinePath,
			`${JSON.stringify(report, null, 2)}\n`,
		);
	}

	if (args.json) {
		console.log(JSON.stringify({ report, deltas }, null, 2));
	} else {
		printSummary(report, deltas, args.updateBaselinePath);
		if (failures) {
			console.error("\nFailures:\n");
			console.error(failures);
		}
	}

	if (failures) process.exitCode = 1;
}

async function readBaseline(path: string): Promise<RagGoldenReport> {
	return JSON.parse(await Bun.file(path).text()) as RagGoldenReport;
}

function printSummary(
	report: RagGoldenReport,
	deltas: ReturnType<typeof compareRagGoldenReports>,
	updatedBaselinePath: string | undefined,
) {
	console.log(`RAG golden eval: ${report.results.length} case variants`);
	for (const variant of report.variants) {
		const delta = deltas.find((item) => item.variantId === variant.variantId);
		const deltaText = delta
			? ` delta pass=${formatDelta(delta.passRateDelta)}`
			: "";
		console.log(
			[
				`- ${variant.variantId}`,
				`pass=${variant.passed}/${variant.total}`,
				`recall=${variant.meanRetrievalRecall.toFixed(3)}`,
				`grounded=${variant.meanGroundedness.toFixed(3)}`,
				`persona=${variant.meanPersonaConsistency.toFixed(3)}`,
				`forbidden=${variant.forbiddenViolations}`,
				`paths=${JSON.stringify(variant.pathCounts)}`,
			].join(" ") + deltaText,
		);
	}
	if (updatedBaselinePath) {
		console.log(`Updated baseline: ${updatedBaselinePath}`);
	}
}

function buildMockAnswer(item: FixtureRagGoldenCase): string {
	const facts =
		item.expectedFacts?.join(" ") ??
		"I will use the available knowledge base context.";
	const persona = item.personaExpectations?.join(" ") ?? "";
	return [facts, persona].filter(Boolean).join(" ");
}

function buildQueryVariants(item: FixtureRagGoldenCase): string {
	const sources = item.expectedSources ?? [];
	const facts = item.expectedFacts ?? [];
	return [...sources, ...facts, item.question].slice(0, 2).join("\n");
}

function deterministicVector(input: string): number[] {
	let a = 1;
	let b = 0;
	for (const char of input) {
		const code = char.codePointAt(0) ?? 0;
		a = (a + code) % 997;
		b = (b + code * 7) % 991;
	}
	return [a / 997, b / 991, 1];
}

function keywordScore(query: string, text: string): number {
	const queryTokens = tokenize(query);
	const haystack = new Set(tokenize(text));
	return queryTokens.reduce(
		(score, token) => score + (haystack.has(token) ? 1 : 0),
		0,
	);
}

function tokenize(text: string): string[] {
	return text
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length >= 3);
}

function formatDelta(value: number): string {
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toFixed(3)}`;
}

main().catch((err) => {
	console.error(err instanceof Error ? err.stack : err);
	process.exitCode = 1;
});
