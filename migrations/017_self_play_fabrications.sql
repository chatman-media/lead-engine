-- Track how many times reflect rejected the bot's reply as ungrounded
-- (fabrication) during a self-play match. High count is a prompt-grounding
-- signal — operator should tighten KB-only constraints in the style.

ALTER TABLE self_play_matches ADD COLUMN fabrications_caught INTEGER NOT NULL DEFAULT 0;
