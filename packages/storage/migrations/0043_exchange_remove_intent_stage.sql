-- 0043_exchange_remove_intent_stage.sql
-- Exchange is now a single exchange workflow. The old first stage
-- `intent_detected` belonged to the legacy concierge/multi-service catalog
-- model and should not live inside exchange_v1.

DO $$
DECLARE
  f record;
  old_stage_id integer;
  new_stage_id integer;
  now_epoch integer := (extract(epoch from now()))::int;
BEGIN
  FOR f IN
    SELECT id, tenant_id
    FROM funnels
    WHERE vertical_template_id = 'exchange_v1' OR slug = 'exchange'
  LOOP
    SELECT id INTO old_stage_id
    FROM stage_definitions
    WHERE tenant_id = f.tenant_id
      AND funnel_id = f.id
      AND slug = 'intent_detected'
    LIMIT 1;

    SELECT id INTO new_stage_id
    FROM stage_definitions
    WHERE tenant_id = f.tenant_id
      AND funnel_id = f.id
      AND slug = 'exchange_request'
    LIMIT 1;

    IF new_stage_id IS NOT NULL THEN
      UPDATE leads
      SET
        state = 'exchange_request',
        stage_definition_id = new_stage_id,
        request_type = NULL,
        updated_at = now_epoch
      WHERE tenant_id = f.tenant_id
        AND stage_definition_id = old_stage_id;

      UPDATE stage_definitions
      SET
        kind = 'intake',
        phase = NULL,
        position = 0,
        color = '#3b82f6',
        updated_at = now_epoch
      WHERE id = new_stage_id;
    END IF;

    UPDATE stage_definitions
    SET position = CASE slug
      WHEN 'exchange_request' THEN 0
      WHEN 'quote_calculated' THEN 1
      WHEN 'verification_check' THEN 2
      WHEN 'kyc_collection' THEN 3
      WHEN 'risk_review' THEN 4
      WHEN 'order_created' THEN 5
      WHEN 'requisites_sent' THEN 6
      WHEN 'payment_proof_waiting' THEN 7
      WHEN 'payment_verified' THEN 8
      WHEN 'payout_or_completion' THEN 9
      WHEN 'cancelled' THEN 10
      ELSE position
    END,
    updated_at = now_epoch
    WHERE tenant_id = f.tenant_id
      AND funnel_id = f.id
      AND slug IN (
        'exchange_request',
        'quote_calculated',
        'verification_check',
        'kyc_collection',
        'risk_review',
        'order_created',
        'requisites_sent',
        'payment_proof_waiting',
        'payment_verified',
        'payout_or_completion',
        'cancelled'
      );

    IF old_stage_id IS NOT NULL THEN
      DELETE FROM stage_definitions
      WHERE id = old_stage_id;
    END IF;
  END LOOP;
END $$;
