-- Durable owner of one RIM provider call. Not a Product fact and not part of rim_provider_runtime.
-- Lease expiry does not replace owner_token. Heartbeat updates this table only.

CREATE TABLE IF NOT EXISTS rim_provider_ownership (
  user_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  request_id TEXT,
  owner_token UUID NOT NULL,
  leased_until TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  CONSTRAINT rim_provider_ownership_pkey PRIMARY KEY (user_id, operation_kind, attempt_id),
  CONSTRAINT rim_provider_ownership_operation_kind_chk CHECK (
    operation_kind IN ('initialization', 'user-attempt')
  ),
  CONSTRAINT rim_provider_ownership_attempt_id_chk CHECK (char_length(attempt_id) > 0),
  CONSTRAINT rim_provider_ownership_request_id_chk CHECK (
    request_id IS NULL
    OR char_length(request_id) > 0
  ),
  CONSTRAINT rim_provider_ownership_release_reason_chk CHECK (
    release_reason IS NULL
    OR release_reason IN (
      'completed',
      'owner-terminated',
      'chat-abandoned',
      'superseded'
    )
  ),
  CONSTRAINT rim_provider_ownership_release_pair_chk CHECK (
    (
      released_at IS NULL
      AND release_reason IS NULL
    )
    OR (
      released_at IS NOT NULL
      AND release_reason IS NOT NULL
    )
  ),
  CONSTRAINT rim_provider_ownership_user_fk FOREIGN KEY (user_id) REFERENCES identity_users (user_id)
);

CREATE INDEX IF NOT EXISTS rim_provider_ownership_open_lease_idx ON rim_provider_ownership (user_id, leased_until)
WHERE
  released_at IS NULL;
