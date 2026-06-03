-- 0027_stage_fields_video_constraint.sql
-- Some production databases still have the older constraint name
-- stage_fields_field_type_check, so 0023 did not replace it. Recreate the
-- field_type CHECK under the current name and allow video fields.

ALTER TABLE "stage_fields"
  DROP CONSTRAINT IF EXISTS "stage_fields_field_type_check";

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

