-- Дублируем поля сделки (asset_from/amount_from) на ПОЗДНИЕ стадии обмена
-- (order_created, requisites_sent), где тоже разрешена перекотировка до оплаты
-- (TOOL_STAGE_MATRIX.compute_exchange_quote). Экстрактор полей смотрит ТОЛЬКО
-- стадию ТЕКУЩЕГО лида, поэтому без этих полей смена суммы/актива после создания
-- заявки («давай теперь 30000») не переизвлекается в leadFieldValues и состояние
-- остаётся СТАРЫМ. Опциональны → авто-переходы стадий не трогают. Идемпотентно
-- (NOT EXISTS по stage+slug). Пара к 0066 (там те же поля на quote_calculated).

INSERT INTO stage_fields
  (stage_id, tenant_id, slug, display_name, field_type, required, position, options_json, hint, ai_extractable)
SELECT sd.id, sd.tenant_id, 'asset_from', 'Что отдаёт клиент', 'select', false, 6,
  '[{"value":"usdt","label":"USDT"},{"value":"btc","label":"BTC"},{"value":"eth","label":"ETH"},{"value":"rub","label":"Рубли (RUB)"},{"value":"eur","label":"EUR"},{"value":"usd","label":"USD"}]',
  'Смена актива при пересчёте до оплаты', true
FROM stage_definitions sd
JOIN funnels f ON f.id = sd.funnel_id
WHERE sd.slug IN ('order_created', 'requisites_sent')
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND NOT EXISTS (
    SELECT 1 FROM stage_fields ex WHERE ex.stage_id = sd.id AND ex.slug = 'asset_from'
  );

INSERT INTO stage_fields
  (stage_id, tenant_id, slug, display_name, field_type, required, position, hint, ai_extractable)
SELECT sd.id, sd.tenant_id, 'amount_from', 'Сумма (в источнике)', 'number', false, 7,
  'Смена суммы при пересчёте до оплаты', true
FROM stage_definitions sd
JOIN funnels f ON f.id = sd.funnel_id
WHERE sd.slug IN ('order_created', 'requisites_sent')
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND NOT EXISTS (
    SELECT 1 FROM stage_fields ex WHERE ex.stage_id = sd.id AND ex.slug = 'amount_from'
  );
