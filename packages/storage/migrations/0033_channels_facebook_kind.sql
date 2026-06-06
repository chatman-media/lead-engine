-- 0033_channels_facebook_kind.sql
-- Issue #179: разрешить kind='facebook' (Facebook Messenger) в channels.
--
-- Адаптер-пакет @chatman-media/channel-facebook влит в #181, и 'facebook' уже
-- в ChannelKind, но CHECK-констрейнт channels_kind_check (migration 0001) о нём
-- не знал — INSERT facebook-канала отвергался Postgres'ом. Пересоздаём
-- констрейнт с добавленным значением (DROP IF EXISTS — идемпотентно).

ALTER TABLE "channels" DROP CONSTRAINT IF EXISTS "channels_kind_check";
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind_check" CHECK ("channels"."kind" IN ('telegram_bot','telegram_userbot','whatsapp','facebook','web'));
