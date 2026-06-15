-- Топик форум-группы оператора на диалог: при потоке заявок от разных клиентов
-- каждый диалог получает свой Telegram-тред (message_thread_id), чтобы карточки
-- не сыпались в один поток и оператор понимал, кому отвечает. NULL = не создан.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS operator_thread_id integer;
