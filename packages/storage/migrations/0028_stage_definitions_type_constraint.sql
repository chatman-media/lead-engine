-- 0028_stage_definitions_type_constraint.sql
-- Counterpart to 0027 for stage_definitions. Migration 0011 created the
-- stage_type CHECK inline, so Postgres auto-named it
-- stage_definitions_stage_type_check. Migration 0023 only dropped/recreated
-- the differently-named stage_definitions_type_check, leaving the original
-- restrictive constraint in place on freshly-migrated (and some legacy) DBs —
-- it lacks rate_confirmation and awaiting_operator, so installing the exchange
-- vertical (which uses rate_confirmation stages) fails. Drop both possible
-- names and recreate the stage_type CHECK under the canonical name with the
-- full universal catalogue.

ALTER TABLE "stage_definitions"
  DROP CONSTRAINT IF EXISTS "stage_definitions_stage_type_check";

ALTER TABLE "stage_definitions"
  DROP CONSTRAINT IF EXISTS "stage_definitions_type_check";

ALTER TABLE "stage_definitions"
  ADD CONSTRAINT "stage_definitions_type_check"
  CHECK (
    "stage_type" IN (
      'form_fill',
      'document_upload',
      'document_signature',
      'rate_confirmation',
      'external_approval',
      'payment',
      'waiting',
      'awaiting_operator',
      'interaction',
      'assessment',
      'milestone'
    )
  );
