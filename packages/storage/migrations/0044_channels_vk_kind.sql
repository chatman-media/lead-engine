-- 0044_channels_vk_kind.sql
-- Разрешить kind='vk' (VK community messages) в channels.

ALTER TABLE "channels" DROP CONSTRAINT IF EXISTS "channels_kind_check";
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind_check" CHECK ("channels"."kind" IN ('telegram_bot','telegram_userbot','whatsapp','facebook','vk','web'));
