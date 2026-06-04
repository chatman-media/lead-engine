-- 0029_llm_transcribe_purpose.sql
-- Новый purpose 'transcribe' для llm_provider_configs — отдельный ключ под
-- расшифровку голосовых (Whisper: OpenAI или Groq), независимый от chat.

ALTER TABLE "llm_provider_configs" DROP CONSTRAINT IF EXISTS "llm_configs_purpose_check";
ALTER TABLE "llm_provider_configs" ADD CONSTRAINT "llm_configs_purpose_check"
  CHECK ("purpose" IN ('chat','embed','vision','judge','reranker','transcribe'));
