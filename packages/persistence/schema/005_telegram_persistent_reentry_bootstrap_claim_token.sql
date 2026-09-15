-- Stage 13A Corrective Pass 3 — bootstrap claim ownership fencing token.

ALTER TABLE product_user_sessions
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_bootstrap_claim_token TEXT;
