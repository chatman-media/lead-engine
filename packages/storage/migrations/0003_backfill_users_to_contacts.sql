-- Backfill data-миграция: переносит legacy users в новую contacts + создаёт
-- channel_identities. Идемпотентная — ON CONFLICT DO NOTHING на каждом
-- INSERT. Запускается ОДИН раз при cutover'е на новую multi-tenant модель.
--
-- Сохраняется 1:1 mapping users.id → contacts.id (через INSERT с явным id).
-- Это позволяет conversations.user_id (legacy FK → users) дальше работать
-- без переписи — в Этапе 9+ FK перевешивается на contacts.id, и users
-- таблица удаляется data-migration'ом.

-- Шаг 1. Гарантировать наличие default telegram_bot channel для legacy
-- tenant'а — нужен как FK target для channel_identities.
INSERT INTO "channels" ("tenant_id", "kind", "external_id", "status", "metadata_json")
  SELECT 1, 'telegram_bot', 'legacy-default', 'active', '{"backfilled":true}'
  WHERE NOT EXISTS (
    SELECT 1 FROM "channels"
    WHERE "tenant_id" = 1 AND "kind" = 'telegram_bot'
  );--> statement-breakpoint

-- Шаг 2. 1:1 mapping users → contacts. Сохраняется users.id как contacts.id
-- для FK preservation. profile_json пакуем в legacy_profile attribute,
-- чтобы оператор мог его прочитать в admin-UI до полного перехода.
INSERT INTO "contacts" ("id", "tenant_id", "display_name", "attributes_json", "created_at", "updated_at")
  SELECT u."id",
         u."tenant_id",
         u."tg_username",
         CASE
           WHEN u."profile_json" IS NOT NULL
             THEN ('{"legacy_profile":' || to_json(u."profile_json")::text || '}')
           ELSE NULL
         END,
         u."created_at",
         u."updated_at"
  FROM "users" u
  ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- Шаг 3. Sequence sync — после INSERT с явным id Postgres-sequence не
-- сдвигается; новый contact без id получил бы конфликт. Forced setval
-- до max(id) + 1.
SELECT setval(
  pg_get_serial_sequence('contacts', 'id'),
  GREATEST(1, COALESCE((SELECT MAX(id) FROM "contacts"), 0))
);--> statement-breakpoint

-- Шаг 4. channel_identities: linking каждого contact (= бывший user) к
-- его default telegram_bot channel'у per tenant. external_user_id = tg_user_id
-- из users. UNIQUE(channel_id, external_user_id) защищает от дублей при
-- повторном прогоне миграции.
INSERT INTO "channel_identities" ("contact_id", "channel_id", "external_user_id", "created_at")
  SELECT u."id",
         (SELECT id FROM "channels"
          WHERE "tenant_id" = u."tenant_id" AND "kind" = 'telegram_bot'
          LIMIT 1),
         u."tg_user_id"::text,
         u."created_at"
  FROM "users" u
  WHERE u."tg_user_id" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "channels"
      WHERE "tenant_id" = u."tenant_id" AND "kind" = 'telegram_bot'
    )
  ON CONFLICT ("channel_id", "external_user_id") DO NOTHING;
