-- Stage 13A Telegram Persistent Re-entry durable facts.

ALTER TABLE product_user_sessions
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_eligible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_established BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_active_request_id TEXT,
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_bootstrap_sent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE bans
  ADD COLUMN IF NOT EXISTS bound_via_telegram_share_link BOOLEAN NOT NULL DEFAULT false;
