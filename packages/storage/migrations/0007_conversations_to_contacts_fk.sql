-- Переключение FK с legacy users на новую contacts таблицу.
--
-- Backfill 0003 создал contacts.id 1:1 от users.id (preserve mapping). После
-- стабильного периода runtime создаёт contacts сам (resolveContact в
-- conversation-engine), без записи в users. На fresh БД (нет legacy data)
-- conversations.user_id ссылается на contact.id, которого нет в users —
-- FK violation. Этот миграционный коммит переключает FK на contacts.
--
-- Lifecycle:
--   - conversations.user_id, leads.user_id, questionnaire_tokens.user_id —
--     все теперь смотрят на contacts(id)
--   - users таблица остаётся как archive до stability period (P2/E),
--     потом dropится отдельной миграцией.
--
-- Идемпотентно через DROP CONSTRAINT IF EXISTS — повторный прогон no-op.

ALTER TABLE "conversations"
  DROP CONSTRAINT IF EXISTS "conversations_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_user_id_contacts_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "leads"
  DROP CONSTRAINT IF EXISTS "leads_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_user_id_contacts_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "questionnaire_tokens"
  DROP CONSTRAINT IF EXISTS "questionnaire_tokens_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "questionnaire_tokens"
  ADD CONSTRAINT "questionnaire_tokens_user_id_contacts_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "contacts"("id") ON DELETE CASCADE;
