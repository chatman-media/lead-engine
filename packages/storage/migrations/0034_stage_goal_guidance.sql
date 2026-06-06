-- 0034_stage_goal_guidance.sql
-- Phase 2 (AI behavior layer): per-stage instructions on dynamic funnels.
--
-- goal     = что должна достичь стадия (для active-стадий);
-- guidance = как боту вести себя на этой стадии.
-- Заполняются AI-сборщиком воронки (admin-workflow) и редактируются оператором.
-- NULL = инструкций нет → бот опирается на активный Style (slice B).
-- Потребление в reply-пайплайне — отдельный слайс (C-2).

ALTER TABLE "stage_definitions" ADD COLUMN IF NOT EXISTS "goal" text;
ALTER TABLE "stage_definitions" ADD COLUMN IF NOT EXISTS "guidance" text;
