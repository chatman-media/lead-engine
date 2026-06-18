-- Курс и итоговая сумма на стадии «Курс рассчитан» (quote_calculated) больше НЕ
-- собираются полями: их вычисляет бот (computeQuote) и хранит заявка
-- (exchange_orders). Убираем устаревшие обязательные stage_fields из уже
-- созданных воронок (сид admin-funnel.ts тоже обновлён) — на этой стадии нужен
-- только факт подтверждения клиентом (rate_confirmed).
-- lead_field_values по этим полям удалятся каскадом (FK ON DELETE CASCADE).
DELETE FROM stage_fields
WHERE slug IN ('exchange_rate', 'thb_amount')
  AND stage_id IN (
    SELECT id FROM stage_definitions WHERE slug = 'quote_calculated'
  );
