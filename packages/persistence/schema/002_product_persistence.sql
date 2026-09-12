-- Stage 4 product facts. No Matrix guards, branch selection, or next-state logic.

CREATE TABLE IF NOT EXISTS product_user_sessions (
  user_id TEXT PRIMARY KEY REFERENCES identity_users (user_id),
  revision BIGINT NOT NULL,
  control_state TEXT,
  session_status TEXT NOT NULL,
  connection TEXT NOT NULL,
  bootstrap JSONB NOT NULL,
  rim_chat JSONB,
  saved_frozen_rim_chat JSONB,
  create_ban_draft JSONB,
  reply_ban_draft JSONB,
  reply_source JSONB,
  successful_ban_id TEXT,
  active_notification_item_id TEXT,
  status_priority_item_id TEXT,
  timer_priority_item_id TEXT,
  pending_external_entry JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_user_sessions_revision_chk CHECK (revision >= 0),
  CONSTRAINT product_user_sessions_session_status_chk CHECK (
    session_status IN ('ACTIVE', 'CLOSED')
  ),
  CONSTRAINT product_user_sessions_connection_chk CHECK (connection IN ('ONLINE', 'OFFLINE')),
  CONSTRAINT product_user_sessions_control_state_canonical_chk CHECK (
    control_state IS NULL
    OR control_state IN (
      'RIM.LOBBY',
      'RIM.CHAT',
      'RIM.SELECT_CONTACT',
      'CREATE_BAN.WHO',
      'CREATE_BAN.WHAT.CONTACT',
      'CREATE_BAN.WHAT.TEMPLATE',
      'CREATE_BAN.WHAT.RIM',
      'CREATE_BAN.CONFIRM.CONTACT',
      'CREATE_BAN.CONFIRM.TEMPLATE',
      'CREATE_BAN.CONFIRM.RIM',
      'CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING',
      'CREATE_BAN.SUCCESS',
      'NOTIFICATIONS.INCOMING_BAN',
      'NOTIFICATIONS.TIMER',
      'NOTIFICATIONS.CHECK.RECEIVER',
      'NOTIFICATIONS.CHECK.SENDER',
      'NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER',
      'NOTIFICATIONS.STATUS.OVERBOARD.SENDER',
      'NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER',
      'NOTIFICATIONS.STATUS.BANTASTIC.SENDER',
      'NOTIFICATIONS.STATUS.BANFLICT.RECEIVER',
      'NOTIFICATIONS.STATUS.BANFLICT.SENDER',
      'NOTIFICATIONS.STATUS.FAIR_ENOUGH.RECEIVER',
      'NOTIFICATIONS.STATUS.FAIR_ENOUGH.SENDER',
      'REPLY_BAN.WHAT.FROM_INCOMING_BAN',
      'REPLY_BAN.CONFIRM.FROM_INCOMING_BAN',
      'REPLY_BAN.SUCCESS.FROM_INCOMING_BAN',
      'REPLY_BAN.WHAT.FROM_STATUS',
      'REPLY_BAN.CONFIRM.FROM_STATUS',
      'REPLY_BAN.SUCCESS.FROM_STATUS'
    )
  )
);

CREATE TABLE IF NOT EXISTS bans (
  ban_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES identity_users (user_id),
  receiver_id TEXT REFERENCES identity_users (user_id),
  ban_text TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  acceptance TEXT NOT NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_seq BIGSERIAL NOT NULL UNIQUE,
  CONSTRAINT bans_duration_minutes_chk CHECK (
    duration_minutes >= 3 AND duration_minutes <= 60
  ),
  CONSTRAINT bans_acceptance_chk CHECK (acceptance IN ('PENDING', 'ACCEPTED')),
  CONSTRAINT bans_status_chk CHECK (
    status IS NULL
    OR status IN ('OVERBOARD', 'BANTASTIC', 'BANFLICT', 'FAIR_ENOUGH')
  )
);

CREATE TABLE IF NOT EXISTS domain_timers (
  timer_id TEXT PRIMARY KEY,
  ban_id TEXT NOT NULL REFERENCES bans (ban_id),
  started_at BIGINT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  state TEXT NOT NULL,
  check_pair_created BOOLEAN NOT NULL,
  CONSTRAINT domain_timers_one_per_ban UNIQUE (ban_id),
  CONSTRAINT domain_timers_state_chk CHECK (state IN ('RUNNING', 'EXPIRED')),
  CONSTRAINT domain_timers_duration_minutes_chk CHECK (
    duration_minutes >= 3 AND duration_minutes <= 60
  )
);

CREATE TABLE IF NOT EXISTS check_pairs (
  pair_id TEXT PRIMARY KEY,
  ban_id TEXT NOT NULL REFERENCES bans (ban_id),
  receiver_item_id TEXT NOT NULL,
  sender_item_id TEXT NOT NULL,
  receiver_answer TEXT,
  sender_answer TEXT,
  resulting_status TEXT,
  CONSTRAINT check_pairs_one_per_ban UNIQUE (ban_id),
  CONSTRAINT check_pairs_receiver_answer_chk CHECK (
    receiver_answer IS NULL OR receiver_answer IN ('FULFILLED', 'NOT_FULFILLED')
  ),
  CONSTRAINT check_pairs_sender_answer_chk CHECK (
    sender_answer IS NULL OR sender_answer IN ('FULFILLED', 'NOT_FULFILLED')
  ),
  CONSTRAINT check_pairs_resulting_status_chk CHECK (
    resulting_status IS NULL
    OR resulting_status IN ('BANTASTIC', 'BANFLICT', 'FAIR_ENOUGH')
  )
);

CREATE TABLE IF NOT EXISTS notification_items (
  item_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES identity_users (user_id),
  ban_id TEXT NOT NULL REFERENCES bans (ban_id),
  kind TEXT NOT NULL,
  fifo_sequence INTEGER NOT NULL,
  lifecycle_status TEXT NOT NULL,
  lifecycle_display TEXT,
  role TEXT,
  check_pair_id TEXT REFERENCES check_pairs (pair_id) DEFERRABLE INITIALLY DEFERRED,
  domain_timer_id TEXT REFERENCES domain_timers (timer_id),
  status TEXT,
  CONSTRAINT notification_items_kind_chk CHECK (
    kind IN ('INCOMING_BAN', 'TIMER', 'CHECK', 'STATUS')
  ),
  CONSTRAINT notification_items_lifecycle_status_chk CHECK (
    lifecycle_status IN ('UNPROCESSED', 'PROCESSED')
  ),
  CONSTRAINT notification_items_lifecycle_display_chk CHECK (
    lifecycle_display IS NULL OR lifecycle_display IN ('WAITING', 'ACTIVE')
  ),
  CONSTRAINT notification_items_lifecycle_shape_chk CHECK (
    (
      lifecycle_status = 'UNPROCESSED'
      AND lifecycle_display IN ('WAITING', 'ACTIVE')
    )
    OR (lifecycle_status = 'PROCESSED' AND lifecycle_display IS NULL)
  ),
  CONSTRAINT notification_items_role_chk CHECK (
    role IS NULL OR role IN ('RECEIVER', 'SENDER')
  ),
  CONSTRAINT notification_items_status_chk CHECK (
    status IS NULL
    OR status IN ('OVERBOARD', 'BANTASTIC', 'BANFLICT', 'FAIR_ENOUGH')
  ),
  CONSTRAINT notification_items_kind_shape_chk CHECK (
    (kind = 'INCOMING_BAN' AND role IS NULL AND check_pair_id IS NULL AND domain_timer_id IS NULL AND status IS NULL)
    OR (kind = 'TIMER' AND domain_timer_id IS NOT NULL AND role IS NULL AND check_pair_id IS NULL AND status IS NULL)
    OR (kind = 'CHECK' AND role IS NOT NULL AND check_pair_id IS NOT NULL AND domain_timer_id IS NULL AND status IS NULL)
    OR (kind = 'STATUS' AND role IS NOT NULL AND status IS NOT NULL AND check_pair_id IS NULL AND domain_timer_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS pending_operations (
  operation_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES identity_users (user_id),
  kind TEXT NOT NULL,
  originating_state TEXT NOT NULL,
  originating_item_id TEXT,
  result_applied BOOLEAN NOT NULL,
  superseded_by_external_entry BOOLEAN NOT NULL,
  send_draft JSONB,
  CONSTRAINT pending_operations_kind_chk CHECK (
    kind IN ('CREATE_BAN_SEND', 'REPLY_BAN_SEND', 'OVERBOARD', 'CHECK_ANSWER')
  )
);

CREATE TABLE IF NOT EXISTS share_operations (
  attempt_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES identity_users (user_id),
  draft JSONB NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL,
  created_ban_id TEXT REFERENCES bans (ban_id),
  CONSTRAINT share_operations_status_chk CHECK (status IN ('ACTIVE', 'CONFIRMED', 'CANCELLED')),
  CONSTRAINT share_operations_created_ban_unique UNIQUE (created_ban_id)
);

CREATE INDEX IF NOT EXISTS bans_sender_created_seq_idx ON bans (sender_id, created_seq DESC);
CREATE INDEX IF NOT EXISTS bans_receiver_created_seq_idx ON bans (receiver_id, created_seq DESC);
CREATE INDEX IF NOT EXISTS bans_pair_created_seq_idx ON bans (sender_id, receiver_id, created_seq);
CREATE INDEX IF NOT EXISTS notification_items_owner_fifo_idx ON notification_items (
  owner_id,
  fifo_sequence
);
CREATE INDEX IF NOT EXISTS notification_items_ban_idx ON notification_items (ban_id);
CREATE INDEX IF NOT EXISTS pending_operations_owner_idx ON pending_operations (owner_id);
CREATE INDEX IF NOT EXISTS share_operations_owner_idx ON share_operations (owner_id);
