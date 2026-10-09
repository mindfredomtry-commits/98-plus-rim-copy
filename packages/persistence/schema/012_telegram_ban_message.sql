-- Delivery address for a Template Ban Telegram bubble.
-- Not Product State. Product Engine remains the sole Ban authority.

CREATE TABLE IF NOT EXISTS telegram_ban_message_deliveries (
  attempt_id TEXT PRIMARY KEY,
  ban_id TEXT NOT NULL REFERENCES bans (ban_id),
  share_token TEXT NOT NULL,
  inline_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT telegram_ban_message_deliveries_token_chk CHECK (char_length(share_token) > 0),
  CONSTRAINT telegram_ban_message_deliveries_inline_chk CHECK (
    inline_message_id IS NULL OR char_length(inline_message_id) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_ban_message_deliveries_token_key
  ON telegram_ban_message_deliveries (share_token);

CREATE INDEX IF NOT EXISTS telegram_ban_message_deliveries_ban_idx
  ON telegram_ban_message_deliveries (ban_id);

-- Idempotency receipts for Telegram callback_query deliveries.
CREATE TABLE IF NOT EXISTS telegram_ban_callback_receipts (
  callback_query_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES telegram_ban_message_deliveries (attempt_id),
  telegram_user_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT telegram_ban_callback_receipts_telegram_user_chk CHECK (
    char_length(telegram_user_id) > 0
  ),
  CONSTRAINT telegram_ban_callback_receipts_outcome_chk CHECK (
    outcome IN (
      'ACCEPTED',
      'DUPLICATE',
      'REJECTED',
      'OVERBOARD_APPLIED',
      'OVERBOARD_NOT_APPLIED',
      'EDIT_FAILED'
    )
  )
);

CREATE INDEX IF NOT EXISTS telegram_ban_callback_receipts_attempt_idx
  ON telegram_ban_callback_receipts (attempt_id);
