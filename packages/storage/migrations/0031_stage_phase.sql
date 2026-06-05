-- 0029_stage_phase.sql
-- Универсальный костяк воронки: ось `phase` (макро-фаза) поверх конкретных
-- стадий. Хранится только для active-стадий — capture/won/lost выводятся из
-- kind. См. packages/verticals/src/phases.ts (источник истины семантики).
--
-- Колонка nullable, БЕЗ default: default ошибочно пометил бы intake/terminal.
-- Backfill детерминированный, по slug активных стадий 5 вертикалей (slug'и
-- уникальны между сидами — коллизий с прочими шаблонами нет). Кастомные/AI-
-- воронки остаются NULL и резолвятся на чтении через effectivePhase().

ALTER TABLE "stage_definitions" ADD COLUMN IF NOT EXISTS "phase" TEXT;

ALTER TABLE "stage_definitions"
  DROP CONSTRAINT IF EXISTS "stage_definitions_phase_check";

ALTER TABLE "stage_definitions"
  ADD CONSTRAINT "stage_definitions_phase_check"
  CHECK ("phase" IS NULL OR "phase" IN ('qualify','offer','clear','fulfill'));

-- ── Backfill активных стадий 5 вертикалей ────────────────────────────────────

UPDATE "stage_definitions" SET "phase" = 'qualify'
  WHERE "phase" IS NULL AND "kind" = 'active' AND "slug" IN (
    'exchange_request', 'brief_call', 'intake_complete', 'viewings',
    'qualified', 'demo_scheduled', 'demo_done'
  );

UPDATE "stage_definitions" SET "phase" = 'offer'
  WHERE "phase" IS NULL AND "kind" = 'active' AND "slug" IN (
    'quote_calculated', 'quote_sent', 'quote_approved', 'partner_review',
    'approved', 'offer_negotiation', 'mou_signed', 'proposal_sent', 'negotiation'
  );

UPDATE "stage_definitions" SET "phase" = 'clear'
  WHERE "phase" IS NULL AND "kind" = 'active' AND "slug" IN (
    'verification_check', 'kyc_collection', 'risk_review', 'docs_pending',
    'docs_complete', 'visa_form', 'visa_filing', 'visa_waiting',
    'noc_application', 'mortgage_approval'
  );

UPDATE "stage_definitions" SET "phase" = 'fulfill'
  WHERE "phase" IS NULL AND "kind" = 'active' AND "slug" IN (
    'order_created', 'requisites_sent', 'payment_proof_waiting',
    'payment_verified', 'shoot_scheduled', 'editing', 'delivery', 'ready_to_work'
  );
