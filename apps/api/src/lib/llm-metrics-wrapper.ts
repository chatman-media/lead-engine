// Wrapper'ы поверх ChatClient/EmbeddingClient из llm-router, которые
// инкрементят счётчики llmCalls/llmErrors на каждый вызов. Labels
// {provider, purpose} — для разбиения метрик по моделям.
//
// Pattern такой же как middleware в HTTP-фреймворках: оригинальный
// клиент в private поле, methods делегируют + side-effect на metric.
//
// Опционально wrapper'ы дёргают `onComplete` callback после каждого
// (успешного или failed) вызова с latency + error info. Boot apps/api
// wire'ит этот callback к batched DB-writer'у который append'ит rows
// в `llm_usage_events` для UI billing dashboard'а.

import type {
	ChatClient,
	ChatCompletionOpts,
	ChatMessage,
	EmbeddingClient,
	TokenUsage,
} from "@chatman-media/llm-router";
import type { PlatformMetrics } from "@chatman-media/observability";

export interface UsageEvent {
	/** chat | embed | vision | judge | memory | stage (см. schema check). */
	purpose: string;
	provider: string;
	model?: string;
	latencyMs: number;
	success: boolean;
	/** Error.name если success=false. */
	errorKind?: string;
	/** Provider-reported prompt-токены. Undefined если провайдер не вернул usage. */
	promptTokens?: number;
	/** Provider-reported completion-токены. Undefined для embed / если нет usage. */
	completionTokens?: number;
}

export type OnUsage = (event: UsageEvent) => void;

export function wrapChatClient(
	inner: ChatClient,
	metrics: PlatformMetrics,
	labels: { provider: string; purpose: string; model?: string },
	onComplete?: OnUsage,
): ChatClient {
	const record = (
		start: number,
		success: boolean,
		errorKind?: string,
		usage?: TokenUsage,
	) => {
		onComplete?.({
			purpose: labels.purpose,
			provider: labels.provider,
			...(labels.model ? { model: labels.model } : {}),
			latencyMs: Math.round(performance.now() - start),
			success,
			...(errorKind ? { errorKind } : {}),
			...(usage?.promptTokens !== undefined
				? { promptTokens: usage.promptTokens }
				: {}),
			...(usage?.completionTokens !== undefined
				? { completionTokens: usage.completionTokens }
				: {}),
		});
	};

	// Подсовывает в opts.onUsage сборщик токенов, не затирая колбэк вызывающего
	// (если тот вдруг тоже подписан). Возвращает { opts, getUsage } — usage
	// доступен после await'а inner-вызова.
	const withUsageCapture = (opts?: ChatCompletionOpts) => {
		let captured: TokenUsage | undefined;
		const callerOnUsage = opts?.onUsage;
		const merged: ChatCompletionOpts = {
			...opts,
			onUsage: (u) => {
				captured = u;
				callerOnUsage?.(u);
			},
		};
		return { opts: merged, getUsage: () => captured };
	};

	const wrapped: ChatClient = {
		async complete(
			messages: ChatMessage[],
			opts?: ChatCompletionOpts,
		): Promise<string> {
			metrics.llmCalls.inc(1, {
				provider: labels.provider,
				purpose: labels.purpose,
			});
			const start = performance.now();
			const cap = withUsageCapture(opts);
			try {
				const result = await inner.complete(messages, cap.opts);
				record(start, true, undefined, cap.getUsage());
				return result;
			} catch (err) {
				const kind = err instanceof Error ? err.name : "unknown";
				metrics.llmErrors.inc(1, {
					provider: labels.provider,
					purpose: labels.purpose,
					kind,
				});
				record(start, false, kind);
				throw err;
			}
		},
	};

	// Пробрасываем опциональные возможности клиента (если inner их реализует),
	// иначе wrapper «съедал» бы function-calling/structured/streaming и tool-loop
	// в RAG никогда бы не запускался (бот не вызывал бы инструменты обмена).
	if (typeof inner.completeWithTools === "function") {
		wrapped.completeWithTools = async (messages, tools, opts) => {
			metrics.llmCalls.inc(1, {
				provider: labels.provider,
				purpose: labels.purpose,
			});
			const start = performance.now();
			const cap = withUsageCapture(opts);
			try {
				// biome-ignore lint/style/noNonNullAssertion: проверили typeof выше
				const result = await inner.completeWithTools!(messages, tools, cap.opts);
				record(start, true, undefined, cap.getUsage());
				return result;
			} catch (err) {
				const kind = err instanceof Error ? err.name : "unknown";
				metrics.llmErrors.inc(1, {
					provider: labels.provider,
					purpose: labels.purpose,
					kind,
				});
				record(start, false, kind);
				throw err;
			}
		};
	}
	if (typeof inner.completeStructured === "function") {
		wrapped.completeStructured = (messages, schema, opts) =>
			// biome-ignore lint/style/noNonNullAssertion: проверили typeof выше
			inner.completeStructured!(messages, schema, opts);
	}
	if (typeof inner.stream === "function") {
		// biome-ignore lint/style/noNonNullAssertion: проверили typeof выше
		wrapped.stream = (messages, opts) => inner.stream!(messages, opts);
	}

	return wrapped;
}

export function wrapEmbeddingClient(
	inner: EmbeddingClient,
	metrics: PlatformMetrics,
	labels: { provider: string; purpose: "embed"; model?: string },
	onComplete?: OnUsage,
): EmbeddingClient {
	return {
		get dim(): number {
			return inner.dim;
		},
		async embed(inputs: string[]): Promise<number[][]> {
			metrics.llmCalls.inc(1, {
				provider: labels.provider,
				purpose: labels.purpose,
			});
			const start = performance.now();
			try {
				const result = await inner.embed(inputs);
				onComplete?.({
					purpose: labels.purpose,
					provider: labels.provider,
					...(labels.model ? { model: labels.model } : {}),
					latencyMs: Math.round(performance.now() - start),
					success: true,
				});
				return result;
			} catch (err) {
				const kind = err instanceof Error ? err.name : "unknown";
				metrics.llmErrors.inc(1, {
					provider: labels.provider,
					purpose: labels.purpose,
					kind,
				});
				onComplete?.({
					purpose: labels.purpose,
					provider: labels.provider,
					...(labels.model ? { model: labels.model } : {}),
					latencyMs: Math.round(performance.now() - start),
					success: false,
					errorKind: kind,
				});
				throw err;
			}
		},
	};
}
