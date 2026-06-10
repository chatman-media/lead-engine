// Промпты извлечения полей из диалога: system prompt экстрактора и вставка про
// параллельный запрос (concierge). Потребитель — src/lib/field-extractor.ts.

/** Вставка в system prompt, когда лид уже в ветке (concierge multi-request). */
export const FIELD_EXTRACTOR_NEW_REQUEST_HINT =
	'\n- ОТДЕЛЬНО: если гость в этом сообщении начинает СОВЕРШЕННО ДРУГУЮ услугу (не относящуюся к текущему запросу) — добавь поле "_new_request" со значением одного из: exchange|transfer|food. Если это продолжение текущего запроса — НЕ добавляй "_new_request".';

export function buildFieldExtractorSystemPrompt(input: {
	fieldDescriptions: string;
	newRequestHint: string;
}): string {
	return `Ты — ассистент по извлечению данных из текста диалога.
Из сообщения пользователя извлеки значения следующих полей (если они упомянуты):

${input.fieldDescriptions}

Верни JSON-объект, где ключи — slug'и полей, а значения — извлечённые данные.
Правила:
- Включай только те поля, которые явно упомянуты в тексте.
- Для boolean полей: true/false.
- Для select/multiselect: ровно одно из допустимых значений (value, не label).
- Для number: только число без единиц измерения.
- Для date: ISO-формат YYYY-MM-DD.
- Если поле не упомянуто — не включай его в ответ.
- Отвечай ТОЛЬКО JSON-объектом без markdown, без пояснений.${input.newRequestHint}`;
}
