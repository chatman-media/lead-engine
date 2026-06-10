import type { ChatClient, ChatMessage } from "@chatman-media/llm-router";

/**
 * Conversation compaction — summarise a message list into a dense text block
 * that fits into the `conversationSummary` field of answerWithRag.
 *
 * Produced summary is ≤ ~500 words.  The call is intentionally cheap:
 *  - temperature = 0 (deterministic, no creativity needed)
 *  - short max-tokens
 *  - no KB retrieval — pure LLM condensation
 *
 * @param messages  Recent messages chronologically (oldest first).
 * @param chat      Chat LLM client (same as the main pipeline).
 * @returns Russian-language summary text, or null if messages list is empty.
 */
export async function compactConversation(
	messages: ChatMessage[],
	chat: ChatClient,
): Promise<string | null> {
	if (messages.length === 0) return null;

	const transcript = messages
		.map((m) => {
			const role = m.role === "user" ? "Кандидат" : "Бот";
			return `${role}: ${String(m.content ?? "").trim()}`;
		})
		.join("\n");

	const systemPrompt = [
		"Ты — суммаризатор диалогов продаж.",
		"Тебе дан фрагмент переписки между ботом и кандидатом.",
		"Напиши КРАТКОЕ резюме на русском языке — 3-7 пунктов:",
		"  • Что узнал кандидат (вопросы, интересы).",
		"  • Что уже выяснено (бюджет, сроки, параметры).",
		"  • На каком этапе находится диалог.",
		"  • Любые особые договорённости или отказы.",
		"",
		"Формат — маркированный список. Без вводных фраз. Только факты.",
	].join("\n");

	const raw = await chat.complete(
		[
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `Диалог:\n${transcript}` },
		],
		{ temperature: 0, numPredict: 400 },
	);

	return raw.trim() || null;
}
