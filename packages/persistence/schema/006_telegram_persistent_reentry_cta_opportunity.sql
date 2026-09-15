-- MVP10 Telegram Persistent Re-entry CTA opportunity fencing (implementation Extended State).

ALTER TABLE product_user_sessions
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_cta_surface_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telegram_persistent_reentry_cta_consumed_surface_generation BIGINT;
