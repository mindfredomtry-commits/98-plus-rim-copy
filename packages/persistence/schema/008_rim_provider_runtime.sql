-- Application-owned RIM provider runtime. Not Product RimChat state.
-- Product session upserts preserve this column; they do not derive it from the kernel snapshot.

ALTER TABLE product_user_sessions
  ADD COLUMN IF NOT EXISTS rim_provider_runtime JSONB;
