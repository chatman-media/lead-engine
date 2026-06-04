-- 0028_admins_name.sql
-- Optional display name for admins (shown in profile / UI greetings).

ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "name" text;
