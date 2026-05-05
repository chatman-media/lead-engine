-- Vacancy → optional canonical link (Telegram channel post / group invite /
-- external page). When set, `renderVacanciesBlock` includes it inside the
-- prompt block so the bot can quote it verbatim when the candidate asks
-- "where to read more / where to apply". Bot is instructed (via the system
-- prompt) to drop the link only when the candidate asks for one — not
-- volunteer it on every reply.
--
-- Nullable on purpose: legacy rows + many vacancies don't have a public
-- post yet. Empty string is normalised to NULL on the API boundary.

ALTER TABLE vacancies ADD COLUMN url TEXT;
