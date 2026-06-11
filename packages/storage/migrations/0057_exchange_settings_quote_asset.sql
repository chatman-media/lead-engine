-- Per-tenant котируемая (локальная) валюта обменника. Правится в админке
-- (Exchange → настройки). Дефолт платформы — PHP (Филиппины); существующие
-- тенанты до этой миграции работали в THB — бэкфиллим, чтобы ничего не сломать.
ALTER TABLE exchange_settings
  ADD COLUMN quote_asset TEXT NOT NULL DEFAULT 'PHP';

UPDATE exchange_settings SET quote_asset = 'THB';

ALTER TABLE exchange_settings
  ADD CONSTRAINT exchange_settings_quote_asset_check
  CHECK (quote_asset ~ '^[A-Z]{3}$');
