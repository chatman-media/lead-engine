-- 0030_admins_name.sql (ранее 0028; переименовано из-за коллизии номера с
-- 0028_stage_definitions_type_constraint на main)
-- Optional display name for admins (shown in profile / UI greetings).

ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "name" text;
