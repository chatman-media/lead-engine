-- 0045_channels_max_kind.sql
-- Разрешить kind='max' (MAX messenger bot channel) в channels.

ALTER TABLE "channels" DROP CONSTRAINT IF EXISTS "channels_kind_check";
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind_check" CHECK ("channels"."kind" IN ('telegram_bot','telegram_userbot','whatsapp','facebook','vk','max','web'));
