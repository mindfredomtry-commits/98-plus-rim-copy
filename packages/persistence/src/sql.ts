export const SQL = {
  selectIdentity: "SELECT user_id FROM identity_users WHERE user_id = $1",
  insertIdentity: `
INSERT INTO identity_users (user_id, telegram_user_id)
VALUES ($1, $2)
ON CONFLICT (user_id) DO NOTHING
`.trim(),
  selectSessionForUpdate: "SELECT * FROM product_user_sessions WHERE user_id = $1 FOR UPDATE",
  upsertSession: `
INSERT INTO product_user_sessions (
  user_id, revision, control_state, session_status, connection, bootstrap,
  rim_chat, saved_frozen_rim_chat, create_ban_draft, reply_ban_draft, reply_source,
  successful_ban_id, active_notification_item_id, status_priority_item_id,
  timer_priority_item_id, pending_external_entry
) VALUES (
  $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb
)
ON CONFLICT (user_id) DO UPDATE SET
  revision = EXCLUDED.revision,
  control_state = EXCLUDED.control_state,
  session_status = EXCLUDED.session_status,
  connection = EXCLUDED.connection,
  bootstrap = EXCLUDED.bootstrap,
  rim_chat = EXCLUDED.rim_chat,
  saved_frozen_rim_chat = EXCLUDED.saved_frozen_rim_chat,
  create_ban_draft = EXCLUDED.create_ban_draft,
  reply_ban_draft = EXCLUDED.reply_ban_draft,
  reply_source = EXCLUDED.reply_source,
  successful_ban_id = EXCLUDED.successful_ban_id,
  active_notification_item_id = EXCLUDED.active_notification_item_id,
  status_priority_item_id = EXCLUDED.status_priority_item_id,
  timer_priority_item_id = EXCLUDED.timer_priority_item_id,
  pending_external_entry = EXCLUDED.pending_external_entry,
  updated_at = NOW()
`.trim(),
  selectBansForUser: `
SELECT ban_id, sender_id, receiver_id, ban_text, duration_minutes, acceptance, status, created_seq
FROM bans
WHERE sender_id = $1 OR receiver_id = $1
`.trim(),
  upsertBan: `
INSERT INTO bans (
  ban_id, sender_id, receiver_id, ban_text, duration_minutes, acceptance, status
) VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (ban_id) DO UPDATE SET
  sender_id = EXCLUDED.sender_id,
  receiver_id = EXCLUDED.receiver_id,
  ban_text = EXCLUDED.ban_text,
  duration_minutes = EXCLUDED.duration_minutes,
  acceptance = EXCLUDED.acceptance,
  status = EXCLUDED.status
`.trim(),
  selectTimersForBans: `
SELECT timer_id, ban_id, started_at, duration_minutes, state, check_pair_created
FROM domain_timers
WHERE ban_id = ANY($1)
`.trim(),
  upsertTimer: `
INSERT INTO domain_timers (
  timer_id, ban_id, started_at, duration_minutes, state, check_pair_created
) VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (timer_id) DO UPDATE SET
  ban_id = EXCLUDED.ban_id,
  started_at = EXCLUDED.started_at,
  duration_minutes = EXCLUDED.duration_minutes,
  state = EXCLUDED.state,
  check_pair_created = EXCLUDED.check_pair_created
`.trim(),
  selectPairsForBans: `
SELECT pair_id, ban_id, receiver_item_id, sender_item_id, receiver_answer, sender_answer, resulting_status
FROM check_pairs
WHERE ban_id = ANY($1)
`.trim(),
  selectPairForUpdate: `
SELECT pair_id, ban_id, receiver_item_id, sender_item_id, receiver_answer, sender_answer, resulting_status
FROM check_pairs
WHERE pair_id = $1
FOR UPDATE
`.trim(),
  upsertPair: `
INSERT INTO check_pairs (
  pair_id, ban_id, receiver_item_id, sender_item_id, receiver_answer, sender_answer, resulting_status
) VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (pair_id) DO UPDATE SET
  ban_id = EXCLUDED.ban_id,
  receiver_item_id = EXCLUDED.receiver_item_id,
  sender_item_id = EXCLUDED.sender_item_id,
  receiver_answer = EXCLUDED.receiver_answer,
  sender_answer = EXCLUDED.sender_answer,
  resulting_status = EXCLUDED.resulting_status
`.trim(),
  selectItemsForUser: `
SELECT item_id, owner_id, ban_id, kind, fifo_sequence, lifecycle_status, lifecycle_display,
       role, check_pair_id, domain_timer_id, status
FROM notification_items
WHERE owner_id = $1
`.trim(),
  upsertItem: `
INSERT INTO notification_items (
  item_id, owner_id, ban_id, kind, fifo_sequence, lifecycle_status, lifecycle_display,
  role, check_pair_id, domain_timer_id, status
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (item_id) DO UPDATE SET
  owner_id = EXCLUDED.owner_id,
  ban_id = EXCLUDED.ban_id,
  kind = EXCLUDED.kind,
  fifo_sequence = EXCLUDED.fifo_sequence,
  lifecycle_status = EXCLUDED.lifecycle_status,
  lifecycle_display = EXCLUDED.lifecycle_display,
  role = EXCLUDED.role,
  check_pair_id = EXCLUDED.check_pair_id,
  domain_timer_id = EXCLUDED.domain_timer_id,
  status = EXCLUDED.status
`.trim(),
  selectOpsForUser: `
SELECT operation_id, owner_id, kind, originating_state, originating_item_id, result_applied,
       superseded_by_external_entry, send_draft
FROM pending_operations
WHERE owner_id = $1
`.trim(),
  upsertOperation: `
INSERT INTO pending_operations (
  operation_id, owner_id, kind, originating_state, originating_item_id, result_applied,
  superseded_by_external_entry, send_draft
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
ON CONFLICT (operation_id) DO UPDATE SET
  owner_id = EXCLUDED.owner_id,
  kind = EXCLUDED.kind,
  originating_state = EXCLUDED.originating_state,
  originating_item_id = EXCLUDED.originating_item_id,
  result_applied = EXCLUDED.result_applied,
  superseded_by_external_entry = EXCLUDED.superseded_by_external_entry,
  send_draft = EXCLUDED.send_draft
`.trim(),
  deleteOpsNotIn: `
DELETE FROM pending_operations
WHERE owner_id = $1 AND NOT (operation_id = ANY($2))
`.trim(),
  deleteItemsNotIn: `
DELETE FROM notification_items
WHERE owner_id = $1 AND NOT (item_id = ANY($2))
`.trim(),
  deleteSharesNotIn: `
DELETE FROM share_operations
WHERE owner_id = $1 AND NOT (attempt_id = ANY($2))
`.trim(),
  selectSharesForUser: `
SELECT attempt_id, owner_id, draft, token, status, created_ban_id
FROM share_operations
WHERE owner_id = $1
`.trim(),
  selectShareByToken: `
SELECT attempt_id, owner_id, draft, token, status, created_ban_id
FROM share_operations
WHERE token = $1
ORDER BY attempt_id
LIMIT 1
`.trim(),
  selectBanById: `
SELECT ban_id, sender_id, receiver_id, ban_text, duration_minutes, acceptance, status, created_seq
FROM bans
WHERE ban_id = $1
`.trim(),
  bindBanReceiverIfUnbound: `
UPDATE bans
SET receiver_id = $2
WHERE ban_id = $1
  AND receiver_id IS NULL
RETURNING ban_id, sender_id, receiver_id, ban_text, duration_minutes, acceptance, status, created_seq
`.trim(),
  upsertShare: `
INSERT INTO share_operations (
  attempt_id, owner_id, draft, token, status, created_ban_id
) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
ON CONFLICT (attempt_id) DO UPDATE SET
  owner_id = EXCLUDED.owner_id,
  draft = EXCLUDED.draft,
  token = EXCLUDED.token,
  status = EXCLUDED.status,
  created_ban_id = EXCLUDED.created_ban_id
`.trim(),
  selectRelationshipBans: `
SELECT ban_id, sender_id, receiver_id, ban_text, status, created_seq
FROM bans
WHERE receiver_id IS NOT NULL
  AND (
    (sender_id = $1 AND receiver_id = $2)
    OR (sender_id = $2 AND receiver_id = $1)
  )
ORDER BY created_seq DESC
LIMIT 10
`.trim(),
} as const;
