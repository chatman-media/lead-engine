#!/usr/bin/env bun
// Live-замер вклада опциональных LLM-шагов answerWithRag (#515): query rewrite,
// multi-query, reflection. Гоняет golden-кейсы (packages/kb/evals/answer-steps.jsonl)
// на РЕАЛЬНЫХ клиентах тенанта (chat/embed из llm_provider_configs + tenant_secrets)
// через evaluateRagGoldenCases с аблациями и печатает таблицу:
// вариант → passRate / recall / groundedness / LLM-вызовы / латентность.
//
// Запуск (нужны DATABASE_URL и PLATFORM_MASTER_KEY в env):
//   bun run apps/api/scripts/run-answer-step-eval.ts --tenant 3 --repeats 2 \
//     --out-md docs/quality/answer-step-eval.md --out-json /tmp/answer-step-eval.json
//
// Каждый кейс несёт свой мини-корпус: он ингестится в InMemoryKbStore с реальными
// эмбеддингами (кеш по тексту — корпус эмбеддится один раз на все варианты/повторы).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDecryptedSecret } from "@chatman-media/conversation-engine";
import {
	type AnswerInput,
	evaluateRagGoldenCases,
	InMemoryKbStore,
	parseRagGoldenJsonl,
	type RagGoldenAblation,
	type RagGoldenCase,
	type RagGoldenReport,
} from "@chatman-media/kb";
import {
	type ChatClient,
	type ChatMessage,
	type EmbeddingClient,
	OllamaChatClient,
	OllamaEmbeddingClient,
	OpenAIChatClient,
	OpenAIEmbeddingClient,
	OpenRouterChatClient,
} from "@chatman-media/llm-router";
import { llmProviderConfigs } from "@chatman-media/storage";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// ── CLI ───────────────────────────────────────────────────────────────────────

export interface CliArgs {
	tenantId: number;
	dataset: string;
	repeats: number;
	/** true → клиенты из LLM_*-переменных env (локальный Ollama и т.п.), без БД и секретов. */
	envClients: boolean;
	/**
	 * true → все корпуса кейсов в ОДНОМ общем KbStore (перекрёстные дистракторы,
	 * ближе к продовому KB). false → у каждого кейса свой изолированный мини-стор.
	 */
	sharedKb: boolean;
	outMd?: string;
	outJson?: string;
	help: boolean;
}

const DEFAULT_DATASET = "packages/kb/evals/answer-steps.jsonl";

export function parseCliArgs(argv: string[]): CliArgs | { error: string } {
	const args: CliArgs = {
		tenantId: 3,
		dataset: DEFAULT_DATASET,
		repeats: 2,
		envClients: false,
		sharedKb: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const raw = argv[i];
		if (!raw) continue;
		const next = () => {
			const value = argv[i + 1];
			i += 1;
			return value;
		};
		if (raw === "--help" || raw === "-h") args.help = true;
		else if (raw === "--env") args.envClients = true;
		else if (raw === "--shared-kb") args.sharedKb = true;
		else if (raw === "--tenant") {
			const value = Number(next());
			if (!Number.isInteger(value) || value <= 0) return { error: "--tenant требует положительный id" };
			args.tenantId = value;
		} else if (raw === "--repeats") {
			const value = Number(next());
			if (!Number.isInteger(value) || value <= 0 || value > 10)
				return { error: "--repeats требует целое 1..10" };
			args.repeats = value;
		} else if (raw === "--dataset") {
			const value = next();
			if (!value) return { error: "--dataset требует путь" };
			args.dataset = value;
		} else if (raw === "--out-md") {
			const value = next();
			if (!value) return { error: "--out-md требует путь" };
			args.outMd = value;
		} else if (raw === "--out-json") {
			const value = next();
			if (!value) return { error: "--out-json требует путь" };
			args.outJson = value;
		} else return { error: `неизвестный аргумент: ${raw}` };
	}
	return args;
}

// ── Варианты (матрица шагов) ──────────────────────────────────────────────────
// Бейзлайн full: rewrite + multi-query + reflect ВКЛЮЧЕНЫ — аблации выключают по
// одному, дельта = вклад шага. prod_default — текущее продакшн-поведение
// не-exchange вертикалей (только rewrite). minimal — все шаги выключены.

export function buildAblations(): RagGoldenAblation[] {
	return [
		{
			id: "no_rewrite",
			label: "− query rewrite",
			mutateInput: (input) => ({ ...input, rewriteQueryBeforeRetrieval: false }),
		},
		{
			id: "no_multi_query",
			label: "− multi-query",
			mutateInput: (input) => ({ ...input, multiQuery: false }),
		},
		{
			id: "no_reflect",
			label: "− reflection",
			mutateInput: (input) => ({ ...input, reflect: false }),
		},
		{
			id: "prod_default",
			label: "prod default (только rewrite)",
			mutateInput: (input) => ({ ...input, multiQuery: false, reflect: false }),
		},
		{
			id: "minimal",
			label: "minimal (все шаги выключены)",
			mutateInput: (input) => ({
				...input,
				rewriteQueryBeforeRetrieval: false,
				multiQuery: false,
				reflect: false,
			}),
		},
	];
}

// ── Агрегация повторов и рендер ───────────────────────────────────────────────

export interface VariantAggregate {
	variantId: string;
	label: string;
	runs: number;
	passRate: number;
	recall: number;
	groundedness: number;
	forbiddenViolations: number;
	meanChatCalls: number;
	medianCaseMs: number;
	pathCounts: Record<string, number>;
}

export interface CellStat {
	variantId: string;
	caseId: string;
	chatCalls: number;
	chatMs: number;
}

export function aggregate(reports: RagGoldenReport[], cells: CellStat[]): VariantAggregate[] {
	const byVariant = new Map<string, VariantAggregate>();
	for (const report of reports) {
		for (const summary of report.variants) {
			const agg = byVariant.get(summary.variantId) ?? {
				variantId: summary.variantId,
				label: summary.label,
				runs: 0,
				passRate: 0,
				recall: 0,
				groundedness: 0,
				forbiddenViolations: 0,
				meanChatCalls: 0,
				medianCaseMs: 0,
				pathCounts: {},
			};
			agg.runs += 1;
			agg.passRate += summary.passRate;
			agg.recall += summary.meanRetrievalRecall;
			agg.groundedness += summary.meanGroundedness;
			agg.forbiddenViolations += summary.forbiddenViolations;
			for (const [path, count] of Object.entries(summary.pathCounts)) {
				agg.pathCounts[path] = (agg.pathCounts[path] ?? 0) + count;
			}
			byVariant.set(summary.variantId, agg);
		}
	}
	for (const agg of byVariant.values()) {
		if (agg.runs > 0) {
			agg.passRate /= agg.runs;
			agg.recall /= agg.runs;
			agg.groundedness /= agg.runs;
		}
		const variantCells = cells.filter((cell) => cell.variantId === agg.variantId);
		if (variantCells.length > 0) {
			agg.meanChatCalls =
				variantCells.reduce((sum, cell) => sum + cell.chatCalls, 0) / variantCells.length;
			agg.medianCaseMs = median(variantCells.map((cell) => cell.chatMs));
		}
	}
	return [...byVariant.values()];
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const low = sorted[mid - 1] ?? 0;
	const high = sorted[mid] ?? 0;
	return sorted.length % 2 === 0 ? (low + high) / 2 : high;
}

export function renderMarkdown(
	aggregates: VariantAggregate[],
	meta: { dataset: string; cases: number; repeats: number; chatLabel: string; embedLabel: string },
): string {
	const lines: string[] = [
		"# answer-step-eval — вклад опциональных LLM-шагов answerWithRag (#515)",
		"",
		`- датасет: \`${meta.dataset}\` (${meta.cases} кейсов), повторов: ${meta.repeats}`,
		`- chat: ${meta.chatLabel}; embed: ${meta.embedLabel}`,
		`- baseline = rewrite + multi-query + reflection включены; аблации выключают шаги`,
		"",
		"| Вариант | pass | recall | grounded | forbidden | LLM-вызовов/кейс | median мс/кейс |",
		"|---|---|---|---|---|---|---|",
	];
	for (const agg of aggregates) {
		lines.push(
			`| ${agg.label} | ${pct(agg.passRate)} | ${pct(agg.recall)} | ${pct(agg.groundedness)} | ${agg.forbiddenViolations} | ${agg.meanChatCalls.toFixed(2)} | ${Math.round(agg.medianCaseMs)} |`,
		);
	}
	lines.push("", "Пути ответа (суммарно по повторам):", "");
	for (const agg of aggregates) {
		const paths = Object.entries(agg.pathCounts)
			.map(([path, count]) => `${path}=${count}`)
			.join(", ");
		lines.push(`- ${agg.label}: ${paths}`);
	}
	return `${lines.join("\n")}\n`;
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

// ── Реальные клиенты тенанта ──────────────────────────────────────────────────

type ProviderRow = {
	purpose: string;
	provider: string;
	model: string;
	secretRef: string | null;
	baseUrl: string | null;
	embedDim: number | null;
	timeoutMs: number | null;
};

async function loadTenantClients(input: {
	databaseUrl: string;
	tenantId: number;
	masterKeyHex: string;
}): Promise<{ chat: ChatClient; embedder: EmbeddingClient; chatLabel: string; embedLabel: string }> {
	const sql = postgres(input.databaseUrl, { max: 1, onnotice: () => {} });
	const db = drizzle(sql);
	try {
		const rows: ProviderRow[] = await db
			.select({
				purpose: llmProviderConfigs.purpose,
				provider: llmProviderConfigs.provider,
				model: llmProviderConfigs.model,
				secretRef: llmProviderConfigs.secretRef,
				baseUrl: llmProviderConfigs.baseUrl,
				embedDim: llmProviderConfigs.embedDim,
				timeoutMs: llmProviderConfigs.timeoutMs,
			})
			.from(llmProviderConfigs)
			.where(
				and(
					eq(llmProviderConfigs.tenantId, input.tenantId),
					inArray(llmProviderConfigs.purpose, ["chat", "embed"]),
				),
			);
		const chatRow = rows.find((row) => row.purpose === "chat");
		const embedRow = rows.find((row) => row.purpose === "embed");
		if (!chatRow) throw new Error(`у тенанта ${input.tenantId} нет chat-конфига`);
		if (!embedRow) throw new Error(`у тенанта ${input.tenantId} нет embed-конфига`);

		const apiKeyFor = async (row: ProviderRow): Promise<string> => {
			if (!row.secretRef) return "";
			const key = await getDecryptedSecret({
				db,
				tenantId: input.tenantId,
				key: row.secretRef,
				masterKeyHex: input.masterKeyHex,
			});
			if (!key) throw new Error(`не удалось расшифровать секрет ${row.secretRef}`);
			return key;
		};

		const chat = buildChatSync(chatRow, await apiKeyFor(chatRow));
		const embedder = buildEmbedder(embedRow, await apiKeyFor(embedRow));
		return {
			chat,
			embedder,
			chatLabel: `${chatRow.provider}/${chatRow.model}`,
			embedLabel: `${embedRow.provider}/${embedRow.model}`,
		};
	} finally {
		await sql.end({ timeout: 5 });
	}
}

function buildChatSync(row: ProviderRow, apiKey: string): ChatClient {
	if (row.provider === "openrouter") {
		return new OpenRouterChatClient({
			apiKey,
			model: row.model,
			...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
			...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
		});
	}
	if (row.provider === "openai") {
		return new OpenAIChatClient({
			apiKey,
			model: row.model,
			baseUrl: row.baseUrl ?? "https://api.openai.com/v1",
			...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
		});
	}
	if (row.provider === "ollama") {
		return new OllamaChatClient({
			host: row.baseUrl ?? "http://localhost:11434",
			model: row.model,
		});
	}
	throw new Error(`неподдерживаемый chat-провайдер: ${row.provider}`);
}

function buildEmbedder(row: ProviderRow, apiKey: string): EmbeddingClient {
	if (row.provider === "openai") {
		return new OpenAIEmbeddingClient({
			apiKey,
			model: row.model,
			baseUrl: row.baseUrl ?? "https://api.openai.com/v1",
			dim: row.embedDim ?? 1536,
		});
	}
	if (row.provider === "ollama") {
		return new OllamaEmbeddingClient({
			host: row.baseUrl ?? "http://localhost:11434",
			model: row.model,
			dim: row.embedDim ?? 768,
		});
	}
	throw new Error(`неподдерживаемый embed-провайдер: ${row.provider}`);
}

/**
 * Клиенты из LLM_*-переменных окружения — путь без БД и tenant_secrets
 * (локальный Ollama, свой ключ в env). Переменные:
 *   LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL / LLM_API_KEY
 *   LLM_EMBED_PROVIDER / LLM_EMBED_MODEL / LLM_EMBED_BASE_URL / LLM_EMBED_API_KEY / LLM_EMBED_DIM
 * Дефолт эмбеддера — ollama bge-m3 (dim 1024), мультиязычный.
 */
function loadEnvClients(env: Record<string, string | undefined>): {
	chat: ChatClient;
	embedder: EmbeddingClient;
	chatLabel: string;
	embedLabel: string;
} {
	const chatRow: ProviderRow = {
		purpose: "chat",
		provider: env.LLM_PROVIDER ?? "ollama",
		model: env.LLM_MODEL ?? "qwen3:latest",
		secretRef: null,
		baseUrl: env.LLM_BASE_URL ?? null,
		embedDim: null,
		timeoutMs: 180000,
	};
	const embedRow: ProviderRow = {
		purpose: "embed",
		provider: env.LLM_EMBED_PROVIDER ?? "ollama",
		model: env.LLM_EMBED_MODEL ?? "bge-m3",
		secretRef: null,
		baseUrl: env.LLM_EMBED_BASE_URL ?? env.LLM_BASE_URL ?? null,
		embedDim: env.LLM_EMBED_DIM ? Number(env.LLM_EMBED_DIM) : 1024,
		timeoutMs: 180000,
	};
	return {
		chat: buildChatSync(chatRow, env.LLM_API_KEY ?? ""),
		embedder: buildEmbedder(embedRow, env.LLM_EMBED_API_KEY ?? env.LLM_API_KEY ?? ""),
		chatLabel: `${chatRow.provider}/${chatRow.model}`,
		embedLabel: `${embedRow.provider}/${embedRow.model}`,
	};
}

// ── Инструментация и корпуса ──────────────────────────────────────────────────

type CaseDoc = { id: number; title: string; source: string; topic?: string | null; text: string };
type CaseWithKb = RagGoldenCase & { kb?: CaseDoc[]; history?: ChatMessage[] };

function makeCachingEmbedder(inner: EmbeddingClient): EmbeddingClient {
	const cache = new Map<string, number[]>();
	return {
		dim: inner.dim,
		embed: async (inputs: string[]) => {
			const missing = inputs.filter((text) => !cache.has(text));
			if (missing.length > 0) {
				const vectors = await inner.embed(missing);
				missing.forEach((text, index) => {
					const vector = vectors[index];
					if (vector) cache.set(text, vector);
				});
			}
			return inputs.map((text) => cache.get(text) ?? []);
		},
	};
}

async function buildCaseStores(
	cases: CaseWithKb[],
	embedder: EmbeddingClient,
	sharedKb: boolean,
): Promise<Map<string, InMemoryKbStore>> {
	const stores = new Map<string, InMemoryKbStore>();
	const sharedStore = sharedKb ? new InMemoryKbStore() : null;
	for (const item of cases) {
		const store = sharedStore ?? new InMemoryKbStore();
		for (const doc of item.kb ?? []) {
			const { id } = await store.upsertDocument({
				source: doc.source,
				title: doc.title,
				contentHash: `${item.id}:${doc.id}`,
				topic: doc.topic ?? null,
			});
			const [embedding] = await embedder.embed([doc.text]);
			await store.insertChunkWithEmbedding({
				documentId: id,
				chunkIndex: 0,
				text: doc.text,
				tokenCount: Math.ceil(doc.text.length / 4),
				embedding: embedding ?? null,
			});
		}
		stores.set(item.id, store);
	}
	return stores;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
	const parsed = parseCliArgs(process.argv.slice(2));
	if ("error" in parsed) {
		console.error(`[answer-step-eval] ${parsed.error}`);
		return 2;
	}
	if (parsed.help) {
		console.log(
			"usage: bun run apps/api/scripts/run-answer-step-eval.ts [--tenant 3] [--repeats 2] [--dataset path.jsonl] [--out-md path] [--out-json path]",
		);
		return 0;
	}
	const raw = readFileSync(resolve(parsed.dataset), "utf8");
	const cases = parseRagGoldenJsonl(raw) as CaseWithKb[];
	console.log(`[answer-step-eval] кейсов: ${cases.length}, повторов: ${parsed.repeats}`);

	let clients: { chat: ChatClient; embedder: EmbeddingClient; chatLabel: string; embedLabel: string };
	if (parsed.envClients) {
		clients = loadEnvClients(process.env);
	} else {
		const databaseUrl = process.env.DATABASE_URL;
		const masterKeyHex = process.env.PLATFORM_MASTER_KEY;
		if (!databaseUrl || !masterKeyHex) {
			console.error("[answer-step-eval] нужны DATABASE_URL и PLATFORM_MASTER_KEY в env (или --env)");
			return 2;
		}
		clients = await loadTenantClients({ databaseUrl, tenantId: parsed.tenantId, masterKeyHex });
	}
	const { chat, embedder, chatLabel, embedLabel } = clients;
	console.log(`[answer-step-eval] chat=${chatLabel} embed=${embedLabel}`);

	const cachingEmbedder = makeCachingEmbedder(embedder);
	const stores = await buildCaseStores(cases, cachingEmbedder, parsed.sharedKb);
	console.log(
		`[answer-step-eval] корпуса проиндексированы (${parsed.sharedKb ? "общий kb-store" : `${stores.size} kb-store`})`,
	);

	// Инструментация: makeInput вызывается в начале каждой ячейки (кейс×вариант),
	// выполнение строго последовательное — обёртка пишет вызовы в текущую ячейку.
	const cells: CellStat[] = [];
	let currentCell: CellStat | null = null;
	const instrumentedChat: ChatClient = {
		complete: async (messages, opts) => {
			const start = performance.now();
			try {
				return await chat.complete(messages, opts);
			} finally {
				if (currentCell) {
					currentCell.chatCalls += 1;
					currentCell.chatMs += performance.now() - start;
				}
			}
		},
		...(chat.completeWithTools
			? {
					completeWithTools: async (messages, tools, opts) => {
						const start = performance.now();
						try {
							// biome-ignore lint/style/noNonNullAssertion: guarded by spread condition
							return await chat.completeWithTools!(messages, tools, opts);
						} finally {
							if (currentCell) {
								currentCell.chatCalls += 1;
								currentCell.chatMs += performance.now() - start;
							}
						}
					},
				}
			: {}),
	};

	const reports: RagGoldenReport[] = [];
	for (let run = 0; run < parsed.repeats; run += 1) {
		const report = await evaluateRagGoldenCases({
			cases,
			makeInput: (item, context) => {
				currentCell = { variantId: context.variantId, caseId: item.id, chatCalls: 0, chatMs: 0 };
				cells.push(currentCell);
				const store = stores.get(item.id);
				if (!store) throw new Error(`нет kb-store для кейса ${item.id}`);
				const input: AnswerInput = {
					question: item.question,
					kb: store,
					embedder: cachingEmbedder as never,
					chat: instrumentedChat as never,
					history: ((item as CaseWithKb).history ?? []) as never,
					topK: 4,
					hybridSearch: true,
					rewriteQueryBeforeRetrieval: true,
					multiQuery: true,
					reflect: true,
					numPredict: 400,
				};
				return input;
			},
			ablations: buildAblations(),
			metadata: { dataset: parsed.dataset, tenantId: parsed.tenantId, run },
		});
		reports.push(report);
		const baseline = report.variants.find((variant) => variant.variantId === "baseline");
		console.log(
			`[answer-step-eval] прогон ${run + 1}/${parsed.repeats}: baseline pass=${baseline ? Math.round(baseline.passRate * 100) : "?"}%`,
		);
	}

	const aggregates = aggregate(reports, cells);
	const markdown = renderMarkdown(aggregates, {
		dataset: parsed.dataset,
		cases: cases.length,
		repeats: parsed.repeats,
		chatLabel,
		embedLabel,
	});
	console.log(`\n${markdown}`);

	if (parsed.outMd) {
		mkdirSync(dirname(resolve(parsed.outMd)), { recursive: true });
		writeFileSync(resolve(parsed.outMd), markdown);
		console.log(`[answer-step-eval] md → ${parsed.outMd}`);
	}
	if (parsed.outJson) {
		mkdirSync(dirname(resolve(parsed.outJson)), { recursive: true });
		writeFileSync(resolve(parsed.outJson), JSON.stringify({ aggregates, reports, cells }, null, 2));
		console.log(`[answer-step-eval] json → ${parsed.outJson}`);
	}
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
