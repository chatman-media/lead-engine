-- Срок действия кода выдачи (epoch seconds). NULL = бессрочный/не задан.
-- Бот не выдаёт клиенту просроченный код (issue_exchange_payout проверяет TTL).
ALTER TABLE exchange_orders ADD COLUMN IF NOT EXISTS payout_code_expires_at INTEGER;
