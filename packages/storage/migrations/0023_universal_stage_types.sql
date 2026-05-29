-- 0023_universal_stage_types.sql
-- Align universal pipeline constraints with the documented stage/field catalogue.

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

ALTER TABLE "stage_fields"
  DROP CONSTRAINT IF EXISTS "stage_fields_type_check";

ALTER TABLE "stage_fields"
  ADD CONSTRAINT "stage_fields_type_check"
  CHECK (
    "field_type" IN (
      'text',
      'textarea',
      'number',
      'date',
      'select',
      'multiselect',
      'boolean',
      'phone',
      'email',
      'file',
      'photo',
      'video'
    )
  );
