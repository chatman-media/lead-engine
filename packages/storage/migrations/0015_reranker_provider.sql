-- Migration: add 'reranker' purpose and 'jina'/'cohere' providers to llm_provider_configs.
-- Reranker configs store Jina/Cohere API keys per-tenant for KB reranking.

-- Drop old check constraints, recreate with extended enum.
ALTER TABLE llm_provider_configs
  DROP CONSTRAINT IF EXISTS llm_configs_purpose_check;

ALTER TABLE llm_provider_configs
  ADD CONSTRAINT llm_configs_purpose_check
  CHECK (purpose IN ('chat', 'embed', 'vision', 'judge', 'reranker'));

ALTER TABLE llm_provider_configs
  DROP CONSTRAINT IF EXISTS llm_configs_provider_check;

ALTER TABLE llm_provider_configs
  ADD CONSTRAINT llm_configs_provider_check
  CHECK (provider IN ('openai', 'openrouter', 'ollama', 'anthropic', 'jina', 'cohere'));
