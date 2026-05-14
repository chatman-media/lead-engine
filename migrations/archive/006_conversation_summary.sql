-- Conversation summarization for long chats. The recent-history window in
-- the RAG path is fixed at 12 messages — past that point, context from
-- earlier turns silently disappears from the LLM prompt. The user-memory
-- layer covers persistent FACTS, but not nuance ("we discussed apartment
-- options last week", "candidate hesitated about the contract length").
--
-- This column stores a periodically-refreshed compressed summary of the
-- conversation up to message-id `summarizedThroughMsgId` (kept inside the
-- JSON), so the system prompt can carry "PRIOR DISCUSSION:" alongside the
-- last 12 raw turns. Refresh runs fire-and-forget after each reply when
-- the gap (messages_since_summary) crosses a staleness threshold.
--
-- Shape: {"summary": "<text>", "summarizedThroughMsgId": <id>, "updatedAt": <unix>}
-- Null on conversations that haven't crossed the summarization length
-- threshold yet (avoids LLM cost on short chats that don't need it).

ALTER TABLE conversations ADD COLUMN summary_json TEXT;
