-- Share token identifies exactly one ShareOperation.
-- New migration: 002 stays the original baseline, and a future runner can
-- apply this unique index idempotently after 001–008.

CREATE UNIQUE INDEX IF NOT EXISTS share_operations_token_key
  ON share_operations (token);
