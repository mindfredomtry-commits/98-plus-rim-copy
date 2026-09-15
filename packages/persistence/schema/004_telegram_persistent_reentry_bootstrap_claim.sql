-- Stage 13A Corrective Pass 2 — atomic bootstrap delivery claim lease.

ALTER TABLE product_user_sessions
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_bootstrap_claimed_until_ms BIGINT;
