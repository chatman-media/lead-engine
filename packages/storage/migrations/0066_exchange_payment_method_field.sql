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

-- Доп. параметры (сеть/выдача/оплата) дублируем на стадию `quote_calculated`:
-- лид авто-уходит туда после asset+amount, а эти поля клиент часто называет уже
-- там — экстрактор смотрит поля только ТЕКУЩЕЙ стадии. Опциональны.
INSERT INTO stage_fields
  (stage_id, tenant_id, slug, display_name, field_type, required, position, options_json, hint, ai_extractable)
SELECT sd.id, sd.tenant_id, v.slug, v.display_name, 'select', false, v.position,
  v.options_json, v.hint, true
FROM stage_definitions sd
JOIN funnels f ON f.id = sd.funnel_id
CROSS JOIN (VALUES
  ('network', 'Сеть (для крипты)', 3,
   '[{"value":"trc20","label":"TRC20"},{"value":"erc20","label":"ERC20"},{"value":"bep20","label":"BEP20"}]',
   'Обязательно для USDT, принимаем TRC20'),
  ('payout_method', 'Способ получения', 4,
   '[{"value":"office","label":"Офис (код)"},{"value":"atm","label":"Банкомат (cardless)"},{"value":"courier_cash","label":"Курьер"},{"value":"thai_bank_transfer","label":"Перевод на тайский банк"}]',
   'Офис (код) или банкомат (cardless)'),
  ('payment_method', 'Способ внесения (для рублей)', 5,
   '[{"value":"sbp_qr","label":"СБП / QR"},{"value":"card_transfer","label":"Карта / перевод"}]',
   'Только для RUB: по СБП/QR или картой/переводом')
) AS v(slug, display_name, position, options_json, hint)
WHERE sd.slug = 'quote_calculated'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND NOT EXISTS (
    SELECT 1 FROM stage_fields ex
    WHERE ex.stage_id = sd.id AND ex.slug = v.slug
  );

-- Сама СДЕЛКА (asset_from/amount_from) тоже дублируется на quote_calculated —
-- иначе re-quote («передумал, 500 USDT») после ухода со exchange_request не
-- переизвлекается и состояние остаётся СТАРЫМ (бот выдаёт не тот актив/реквизиты).
-- Опциональны → авто-переход quote_calculated не трогают.
INSERT INTO stage_fields
  (stage_id, tenant_id, slug, display_name, field_type, required, position, options_json, hint, ai_extractable)
SELECT sd.id, sd.tenant_id, 'asset_from', 'Что отдаёт клиент', 'select', false, 6,
  '[{"value":"usdt","label":"USDT"},{"value":"btc","label":"BTC"},{"value":"eth","label":"ETH"},{"value":"rub","label":"Рубли (RUB)"},{"value":"eur","label":"EUR"},{"value":"usd","label":"USD"}]',
  'Смена актива при пересчёте', true
FROM stage_definitions sd
JOIN funnels f ON f.id = sd.funnel_id
WHERE sd.slug = 'quote_calculated'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND NOT EXISTS (
    SELECT 1 FROM stage_fields ex WHERE ex.stage_id = sd.id AND ex.slug = 'asset_from'
  );

INSERT INTO stage_fields
  (stage_id, tenant_id, slug, display_name, field_type, required, position, hint, ai_extractable)
SELECT sd.id, sd.tenant_id, 'amount_from', 'Сумма (в источнике)', 'number', false, 7,
  'Смена суммы при пересчёте', true
FROM stage_definitions sd
JOIN funnels f ON f.id = sd.funnel_id
WHERE sd.slug = 'quote_calculated'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND NOT EXISTS (
    SELECT 1 FROM stage_fields ex WHERE ex.stage_id = sd.id AND ex.slug = 'amount_from'
  );

-- Расширяем варианты способа выдачи у УЖЕ заведённых полей payout_method
-- (раньше только office/atm) — добавляем курьера и тайский банк, которые бот/тул
-- и так поддерживают (PayoutMethodEnum). Идемпотентно: ставим полный набор
-- только там, где сейчас старый сокращённый. Значения office/atm остаются
-- (нормализуются в тулах), просто пополняем список.
UPDATE stage_fields sf
SET options_json =
  '[{"value":"office","label":"Офис (код)"},{"value":"atm","label":"Банкомат (cardless)"},{"value":"courier_cash","label":"Курьер"},{"value":"thai_bank_transfer","label":"Перевод на тайский банк"}]'
FROM stage_definitions sd, funnels f
WHERE sf.stage_id = sd.id
  AND sd.funnel_id = f.id
  AND sf.slug = 'payout_method'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND sf.options_json NOT LIKE '%courier_cash%';
