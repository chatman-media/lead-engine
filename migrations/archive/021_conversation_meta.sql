-- Extensible metadata column for conversations. Stores small operational
-- state that doesn't warrant a dedicated column:
--   stall_count  INTEGER  — consecutive NO_CONTEXT stalls since last real answer.
--                           When >= 3, the bot sends a CTA-fallback instead of
--                           another "Секунду, уточню…" to break the deadloop.
-- JSON object; NULL on rows created before this migration (treated as {}).
ALTER TABLE conversations ADD COLUMN meta_json TEXT;
