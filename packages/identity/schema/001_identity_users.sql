-- Stage 3 identity mapping only.
-- telegram_user_id is the verified Telegram provider identity.
-- user_id is the stable internal 98+ UserId.

CREATE TABLE IF NOT EXISTS identity_users (
  user_id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
