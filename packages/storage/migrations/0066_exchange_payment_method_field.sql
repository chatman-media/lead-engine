-- Бэкфилл поля `payment_method` на стадию `exchange_request` существующих
-- exchange-воронок. Сид (SEED_TEMPLATES.exchange) применяется только к НОВЫМ
-- тенантам, поэтому уже заведённым обменникам поле нужно добавить миграцией —
-- иначе универсальный сбор способа внесения (СБП/QR vs карта/перевод) для RUB
-- не работает. Идемпотентно (NOT EXISTS + уникальный индекс stage+slug).

INSERT INTO stage_fields
  (stage_id, tenant_id, slug, display_name, field_type, required, position, options_json, hint, ai_extractable)
SELECT
  sd.id,
  sd.tenant_id,
  'payment_method',
  'Способ внесения (для рублей)',
  'select',
  false,
  4,
  '[{"value":"sbp_qr","label":"СБП / QR"},{"value":"card_transfer","label":"Карта / перевод"}]',
  'Только для RUB: по СБП/QR или картой/переводом',
  true
FROM stage_definitions sd
JOIN funnels f ON f.id = sd.funnel_id
WHERE sd.slug = 'exchange_request'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND NOT EXISTS (
    SELECT 1 FROM stage_fields ex
    WHERE ex.stage_id = sd.id AND ex.slug = 'payment_method'
  );
