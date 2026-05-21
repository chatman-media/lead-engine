-- Удаление legacy `users` таблицы.
--
-- История:
--   - 0000_init_full_schema: создание users (clone из tg-chatbot legacy schema)
--   - 0003_backfill_users_to_contacts: 1:1 copy users → contacts (id preservation)
--   - 0007_conversations_to_contacts_fk: переключение FK с users → contacts
--   - 0008 (этот): drop users — никто больше не зависит от неё
--
-- Runtime код больше не пишет в users (после Stage 5 cutover):
--   - resolveContact в conversation-engine создаёт Contact + ChannelIdentity
--   - admin-API ходит в contacts через ContactsRepo
-- Старые backfill'нутые users-rows доступны через contacts.attributes_json
-- ({"legacy_profile": ...}) — operator увидит legacy data в admin UI.
--
-- Идемпотентно: DROP TABLE IF EXISTS.

DROP TABLE IF EXISTS "users";
