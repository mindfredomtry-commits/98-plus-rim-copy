-- Durable RIM conversation archive. Not a Product Control State and not a Product Event.
-- Rows are written in the same transaction as the Product session commit.

CREATE TABLE IF NOT EXISTS rim_chats (
  rim_chat_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES identity_users (user_id),
  contact_user_id TEXT NOT NULL REFERENCES identity_users (user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  terminated_at TIMESTAMPTZ,
  termination_reason TEXT,
  openai_conversation_id TEXT,
  resulting_ban_id TEXT REFERENCES bans (ban_id),
  CONSTRAINT rim_chats_termination_chk CHECK (
    (
      terminated_at IS NULL
      AND termination_reason IS NULL
    )
    OR (
      terminated_at IS NOT NULL
      AND termination_reason IS NOT NULL
    )
  ),
  CONSTRAINT rim_chats_termination_reason_chk CHECK (
    termination_reason IS NULL
    OR termination_reason IN (
      'contact_changed',
      'chat_closed',
      'full_close',
      'create_ban_success',
      'ask_rim_replaced',
      'initialization_unrecoverable',
      'session_reset',
      'external_entry'
    )
  )
);

CREATE INDEX IF NOT EXISTS rim_chats_owner_created_idx ON rim_chats (owner_user_id, created_at);

CREATE INDEX IF NOT EXISTS rim_chats_resulting_ban_idx ON rim_chats (resulting_ban_id)
WHERE
  resulting_ban_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rim_messages (
  message_key TEXT PRIMARY KEY,
  rim_chat_id TEXT NOT NULL REFERENCES rim_chats (rim_chat_id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  source_ai_request_id TEXT,
  source_context_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rim_messages_ordinal_positive_chk CHECK (ordinal >= 1),
  CONSTRAINT rim_messages_chat_ordinal_key UNIQUE (rim_chat_id, ordinal),
  CONSTRAINT rim_messages_kind_chk CHECK (kind IN ('USER', 'RIM', 'BAN_PROPOSALS')),
  CONSTRAINT rim_messages_source_chk CHECK (
    (
      kind = 'USER'
      AND source_ai_request_id IS NOT NULL
      AND source_context_request_id IS NULL
    )
    OR (
      kind = 'BAN_PROPOSALS'
      AND source_ai_request_id IS NOT NULL
      AND source_context_request_id IS NULL
    )
    OR (
      kind = 'RIM'
      AND (
        (
          source_ai_request_id IS NOT NULL
          AND source_context_request_id IS NULL
        )
        OR (
          source_ai_request_id IS NULL
          AND source_context_request_id IS NOT NULL
        )
      )
    )
  )
);
