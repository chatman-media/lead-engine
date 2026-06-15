-- Opt-in флаг «целевой чат правила — форум-группа» (#651). Когда true и правило
-- ведёт в telegram-группу, operator bot создаёт отдельный топик на каждый диалог
-- (conversations.operator_thread_id) и шлёт карточку/ответы в этот тред, чтобы
-- заявки разных клиентов не сыпались в один поток. Default false — тенанты без
-- форум-группы работают как раньше (без топиков, единый чат).
ALTER TABLE notification_rules
	ADD COLUMN IF NOT EXISTS target_is_forum boolean NOT NULL DEFAULT false;
