#!/usr/bin/env bun
/**
 * Import exchange requisites from a Telegram HTML export.
 *
 * Dry-run:
 *   bun run apps/api/scripts/import-exchange-requisites.ts \
 *     --html=/Users/aleksandrkireev/Downloads/messages.html
 *
 * Apply to a tenant:
 *   DATABASE_URL=postgres://lead:lead@localhost:5434/lead_engine \
 *   PLATFORM_MASTER_KEY=<64hex> \
 *   bun run apps/api/scripts/import-exchange-requisites.ts \
 *     --html=/Users/aleksandrkireev/Downloads/messages.html \
 *     --tenant=oleg-demo \
 *     --apply
 *
 * Selection:
 *   - by default the newest candidate per exchange key wins;
 *   - --prefer=west|bithub|panel|kedsuda|lucky|argsun biases selection;
 *   - --only=exchange_wallet_usdt_trc20,exchange_binance_id limits writes.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setEncryptedSecret } from "@chatman-media/conversation-engine";
import { tenants } from "@chatman-media/storage";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

interface Args {
	htmlPath: string;
	tenant: string | null;
	tenantId: number | null;
	apply: boolean;
	prefer: string;
	only: Set<string> | null;
	includeBusiness: boolean;
}

interface Candidate {
	key: string;
	value: string;
	source: string;
	textIndex: number;
	confidence: number;
}

const BUSINESS_KEYS = new Set(["exchange_kyc_policy", "exchange_payout_methods"]);

const BTC_RE = /\bbc1[ac-hj-np-z02-9]{20,80}\b/gi;
const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const TRON_RE = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g;
const TON_RE = /\b(?:EQ|UQ)[A-Za-z0-9_-]{46}\b/g;
const SOLANA_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const LTC_RE = /\b(?:ltc1|[LM3])[a-km-zA-HJ-NP-Z1-9]{26,90}\b/gi;

function parseArgs(): Args {
	const out: Partial<Args> = {
		apply: false,
		prefer: "latest",
		includeBusiness: false,
	};
	for (const arg of process.argv.slice(2)) {
		if (arg === "--apply") {
			out.apply = true;
			continue;
		}
		if (arg === "--dry-run") {
			out.apply = false;
			continue;
		}
		if (arg === "--include-business") {
			out.includeBusiness = true;
			continue;
		}
		const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
		const value = rest.join("=");
		if (!rawKey || !value) continue;
		if (rawKey === "html") out.htmlPath = value;
		else if (rawKey === "tenant") out.tenant = value;
		else if (rawKey === "tenant-id") out.tenantId = Number(value);
		else if (rawKey === "prefer") out.prefer = value.toLowerCase();
		else if (rawKey === "only") {
			out.only = new Set(
				value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean),
			);
		}
	}
	if (!out.htmlPath) throw new Error("--html required");
	if (out.tenantId != null && !Number.isInteger(out.tenantId)) {
		throw new Error("--tenant-id must be an integer");
	}
	return {
		htmlPath: out.htmlPath,
		tenant: out.tenant ?? null,
		tenantId: out.tenantId ?? null,
		apply: out.apply ?? false,
		prefer: out.prefer ?? "latest",
		only: out.only ?? null,
		includeBusiness: out.includeBusiness ?? false,
	};
}

function decodeHtml(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		nbsp: " ",
		quot: '"',
	};
	return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
		const e = String(entity).toLowerCase();
		if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
		if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
		return named[e] ?? match;
	});
}

function textBlocksFromTelegramHtml(html: string): string[] {
	const normalized = html.replace(/<br\s*\/?\s*>/gi, "\n");
	const blocks: string[] = [];
	const re = /<div\b[^>]*class="[^"]*\btext\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
	for (const match of normalized.matchAll(re)) {
		const text = decodeHtml(match[1] ?? "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\r/g, "")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.join("\n")
			.replace(/[ \t]+/g, " ")
			.trim();
		if (text) blocks.push(text);
	}
	return blocks;
}

function compactSource(text: string): string {
	const firstLines = text
		.split("\n")
		.slice(0, 3)
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" / ");
	return firstLines.length > 140 ? `${firstLines.slice(0, 137)}...` : firstLines;
}

function addCandidate(
	out: Candidate[],
	seen: Set<string>,
	candidate: Candidate,
): void {
	const value = candidate.value.trim();
	if (!value) return;
	const dedupeKey = `${candidate.key}\u0000${value}`;
	if (seen.has(dedupeKey)) return;
	seen.add(dedupeKey);
	out.push({ ...candidate, value });
}

function includesAny(text: string, words: string[]): boolean {
	return words.some((word) => text.includes(word));
}

function inferEvmCandidate(text: string): { key: string; confidence: number } | null {
	const lower = text.toLowerCase();
	let network: string | null = null;
	if (/bep\s*-?\s*20|bsc/.test(lower)) network = "bep20";
	else if (/erc\s*-?\s*20/.test(lower)) network = "erc20";
	else if (lower.includes("usdc")) network = "erc20";

	if (!network) return null;

	let asset = "usdt";
	if (lower.includes("usdc")) asset = "usdc";
	else if (lower.includes("eth") && !lower.includes("usdt")) asset = "eth";

	return {
		key: `exchange_wallet_${asset}_${network}`,
		confidence: lower.includes("usdt") || lower.includes("usdc") ? 9 : 7,
	};
}

function formatTonValue(text: string, address: string): string {
	const after = text.slice(text.indexOf(address) + address.length);
	const taggedMemo =
		/(?:memo|tag|teg|мемо|тег)[\s\S]{0,50}?([A-Fa-f0-9]{10,}|[0-9]{7,})/i.exec(after)?.[1];
	const slashMemo = /\/\s*([A-Fa-f0-9]{10,}|[0-9]{7,})/i.exec(after)?.[1];
	const memo = taggedMemo ?? slashMemo;
	return memo ? `${address} / memo ${memo}` : address;
}

function extractCandidates(blocks: string[]): Candidate[] {
	const candidates: Candidate[] = [];
	const seen = new Set<string>();

	blocks.forEach((text, idx) => {
		const lower = text.toLowerCase();
		const source = compactSource(text);
		const base = { source, textIndex: idx + 1 };

		for (const match of text.matchAll(BTC_RE)) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_wallet_btc_default",
				value: match[0],
				confidence: lower.includes("btc") || lower.includes("втс") ? 10 : 8,
			});
		}

		for (const match of text.matchAll(EVM_RE)) {
			const inferred = inferEvmCandidate(text);
			if (!inferred) continue;
			addCandidate(candidates, seen, {
				...base,
				key: inferred.key,
				value: match[0],
				confidence: inferred.confidence,
			});
		}

		for (const match of text.matchAll(TRON_RE)) {
			const asset =
				includesAny(lower, ["trx", "tron"]) && !lower.includes("usdt")
					? "trx"
					: "usdt";
			if (asset === "trx" || includesAny(lower, ["trc20", "trc-20", "tron", "usdt", "биржа", "панель"])) {
				addCandidate(candidates, seen, {
					...base,
					key: asset === "trx" ? "exchange_wallet_trx_tron" : "exchange_wallet_usdt_trc20",
					value: match[0],
					confidence: asset === "trx" ? 8 : 9,
				});
			}
		}

		for (const match of text.matchAll(TON_RE)) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_wallet_usdt_ton",
				value: formatTonValue(text, match[0]),
				confidence: lower.includes("usdt") || lower.includes("ton") ? 9 : 7,
			});
		}

		if (lower.includes("solana")) {
			for (const match of text.matchAll(SOLANA_RE)) {
				const value = match[0];
				if (value.startsWith("http") || value.startsWith("USDT")) continue;
				addCandidate(candidates, seen, {
					...base,
					key: "exchange_wallet_usdt_solana",
					value,
					confidence: 9,
				});
			}
		}

		if (lower.includes("ltc")) {
			for (const match of text.matchAll(LTC_RE)) {
				addCandidate(candidates, seen, {
					...base,
					key: "exchange_wallet_ltc_default",
					value: match[0],
					confidence: 9,
				});
			}
		}

		const binance = /binance[\s\S]*?\bID\s*:?\s*(\d{5,})|\bID\s*:?\s*(\d{5,})[\s\S]*?binance/i.exec(text);
		const binanceId = binance?.[1] ?? binance?.[2];
		if (binanceId) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_binance_id",
				value: binanceId,
				confidence: 10,
			});
		}

		const bybit = /(?:by\s*bit|bybit)[\s\S]*?(?:UID|ID)\s*:?\s*(\d{5,})|(?:UID|ID)\s*:?\s*(\d{5,})[\s\S]*?(?:by\s*bit|bybit)/i.exec(text);
		const bybitUid = bybit?.[1] ?? bybit?.[2];
		if (bybitUid) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_bybit_uid",
				value: bybitUid,
				confidence: 10,
			});
		}

		const htx = /htx[\s\S]*?(?:UID|ID)?\s*:?\s*(\d{5,})|(\d{5,})\s*(?:UID|ID)?[\s\S]*?htx/i.exec(text);
		const htxUid = htx?.[1] ?? htx?.[2];
		if (htxUid) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_htx_uid",
				value: htxUid,
				confidence: 10,
			});
		}

		if (/bangkok\s+bank/i.test(text) && /\b\d{7,14}\b/.test(text)) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_payout_methods",
				value: text,
				confidence: 7,
			});
		}

		if (/westwallet\.io\/page\/ru\/(?:aml|kyc)|westwallet\.io\/fees/i.test(text)) {
			addCandidate(candidates, seen, {
				...base,
				key: "exchange_kyc_policy",
				value: text,
				confidence: lower.includes("aml") || lower.includes("kyc") ? 9 : 7,
			});
		}
	});

	return candidates.sort((a, b) => a.textIndex - b.textIndex || a.key.localeCompare(b.key));
}

function candidateScore(candidate: Candidate, prefer: string): number {
	const source = candidate.source.toLowerCase();
	let score = candidate.confidence * 10 + candidate.textIndex / 100;
	if (prefer !== "latest" && source.includes(prefer)) score += 1000;
	return score;
}

function selectCandidates(candidates: Candidate[], args: Args): Candidate[] {
	const grouped = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		if (args.only && !args.only.has(candidate.key)) continue;
		if (!args.includeBusiness && BUSINESS_KEYS.has(candidate.key)) continue;
		const group = grouped.get(candidate.key) ?? [];
		group.push(candidate);
		grouped.set(candidate.key, group);
	}

	return [...grouped.entries()]
		.map(([, group]) =>
			group.slice().sort((a, b) => {
				const score = candidateScore(b, args.prefer) - candidateScore(a, args.prefer);
				return score !== 0 ? score : b.textIndex - a.textIndex;
			})[0],
		)
		.filter((item): item is Candidate => item != null)
		.slice()
		.sort((a, b) => a.key.localeCompare(b.key));
}

function printPreview(blocks: string[], candidates: Candidate[], selected: Candidate[], args: Args): void {
	console.log(`[import-requisites] html blocks: ${blocks.length}`);
	console.log(`[import-requisites] candidates: ${candidates.length}`);
	console.log(`[import-requisites] selected (${args.apply ? "apply" : "dry-run"}): ${selected.length}`);
	console.log("");
	for (const candidate of selected) {
		console.log(`${candidate.key} = ${candidate.value}`);
		console.log(`  source: text ${candidate.textIndex}; ${candidate.source}`);
	}
	const skippedBusiness = candidates.filter((item) => BUSINESS_KEYS.has(item.key)).length;
	if (!args.includeBusiness && skippedBusiness > 0) {
		console.log("");
		console.log(
			`[import-requisites] skipped ${skippedBusiness} business candidate(s); pass --include-business to include them.`,
		);
	}
}

async function resolveTenantId(args: Args): Promise<number> {
	if (args.tenantId != null) return args.tenantId;
	if (!args.tenant) throw new Error("--tenant or --tenant-id required with --apply");

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL env required with --apply");
	const client = postgres(databaseUrl, { max: 2 });
	const db = drizzle(client);
	try {
		const [tenant] = await db
			.select({ id: tenants.id, slug: tenants.slug })
			.from(tenants)
			.where(eq(tenants.slug, args.tenant))
			.limit(1);
		if (!tenant) throw new Error(`tenant not found: ${args.tenant}`);
		return tenant.id;
	} finally {
		await client.end();
	}
}

async function applySelected(args: Args, selected: Candidate[]): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	const masterKeyHex = process.env.PLATFORM_MASTER_KEY;
	if (!databaseUrl) throw new Error("DATABASE_URL env required with --apply");
	if (!masterKeyHex) throw new Error("PLATFORM_MASTER_KEY env required with --apply");

	const tenantId = await resolveTenantId(args);
	const client = postgres(databaseUrl, { max: 2 });
	const db = drizzle(client);
	const now = Math.floor(Date.now() / 1000);
	try {
		for (const item of selected) {
			await setEncryptedSecret({
				db,
				tenantId,
				key: item.key,
				value: item.value,
				masterKeyHex,
				nowEpoch: now,
			});
			console.log(`[import-requisites] saved ${item.key}`);
		}
		console.log(`[import-requisites] done tenant_id=${tenantId} saved=${selected.length}`);
	} finally {
		await client.end();
	}
}

async function main() {
	const args = parseArgs();
	const htmlPath = resolve(args.htmlPath);
	if (!existsSync(htmlPath)) throw new Error(`file not found: ${htmlPath}`);

	const html = readFileSync(htmlPath, "utf8");
	const blocks = textBlocksFromTelegramHtml(html);
	const candidates = extractCandidates(blocks);
	const selected = selectCandidates(candidates, args);
	printPreview(blocks, candidates, selected, args);

	if (args.apply) {
		if (selected.length === 0) throw new Error("nothing selected; aborting");
		await applySelected(args, selected);
	}
}

main().catch((err) => {
	console.error("[import-requisites] FAILED:", err instanceof Error ? err.message : err);
	process.exit(1);
});
