-- Переименование подписей полей стадии обмена у УЖЕ заведённых exchange-воронок.
-- Сид (SEED_TEMPLATES.exchange) применяется только к НОВЫМ тенантам, поэтому
-- косметику подписей существующим обменникам правим миграцией. Идемпотентно
-- (UPDATE по LIKE на старую формулировку / REPLACE по подстроке — повторный
-- запуск ничего не меняет, кастомные подписи оператора не трогаем). Пара к
-- 0066/0069 (там те же поля заводились).
--
-- Что меняем:
--   • amount_from  "Сумма (в источнике)" / "Сумма (в активе-источнике)"
--     → "Сумма к обмену" (прежняя формулировка звучала коряво).
--   • payout_method "Способ получения PHP/THB/…" → "Способ выдачи" — убираем
--     сырой ISO-код котируемой валюты из подписи: валюта выдачи у тенанта одна
--     (exchange_settings.quote_asset), дропдаун задаёт СПОСОБ, а не валюту.
--   • payout_method опция "Перевод на тайский банк" → "Перевод на банк" —
--     регион-нейтрально (дефолт платформы PHP, а не THB). Значение enum
--     thai_bank_transfer НЕ трогаем — на него завязаны схема/тулы/корпус.
--   • thb_amount "Итоговая сумма PHP/THB/…" → "Итоговая сумма к выдаче" и
--     final_thb_paid "Выдано PHP/THB/…" → "Выданная сумма" — тот же выпил
--     сырого ISO-кода котируемой валюты из подписи (поле заполняет тул-расчёт,
--     не клиент; валюта у тенанта одна).

-- amount_from на всех стадиях обмена (ловим оба «…в источнике…» варианта).
UPDATE stage_fields sf
SET display_name = 'Сумма к обмену'
FROM stage_definitions sd, funnels f
WHERE sf.stage_id = sd.id
  AND sd.funnel_id = f.id
  AND sf.slug = 'amount_from'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND sf.display_name LIKE 'Сумма%источник%';

-- payout_method: подпись (нормализуем любую прежнюю «Способ получения …») и
-- подсказку.
UPDATE stage_fields sf
SET
  display_name = 'Способ выдачи',
  hint = 'Наличные в офисе, банкомат, курьер или перевод на банк'
FROM stage_definitions sd, funnels f
WHERE sf.stage_id = sd.id
  AND sd.funnel_id = f.id
  AND sf.slug = 'payout_method'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND sf.display_name LIKE 'Способ получения%';

-- payout_method: регион-нейтральная подпись опции банка (значение не трогаем).
UPDATE stage_fields sf
SET options_json = REPLACE(sf.options_json, 'Перевод на тайский банк', 'Перевод на банк')
FROM stage_definitions sd, funnels f
WHERE sf.stage_id = sd.id
  AND sd.funnel_id = f.id
  AND sf.slug = 'payout_method'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND sf.options_json LIKE '%Перевод на тайский банк%';

-- thb_amount: убираем ISO-код из подписи рассчитанной суммы к выдаче.
UPDATE stage_fields sf
SET display_name = 'Итоговая сумма к выдаче'
FROM stage_definitions sd, funnels f
WHERE sf.stage_id = sd.id
  AND sd.funnel_id = f.id
  AND sf.slug = 'thb_amount'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND sf.display_name LIKE 'Итоговая сумма%';

-- final_thb_paid: убираем ISO-код из подписи фактически выданной суммы.
UPDATE stage_fields sf
SET display_name = 'Выданная сумма'
FROM stage_definitions sd, funnels f
WHERE sf.stage_id = sd.id
  AND sd.funnel_id = f.id
  AND sf.slug = 'final_thb_paid'
  AND (f.vertical_template_id = 'exchange_v1' OR f.slug = 'exchange')
  AND sf.display_name LIKE 'Выдано%';
