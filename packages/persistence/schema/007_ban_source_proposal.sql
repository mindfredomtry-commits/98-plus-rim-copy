-- Pass 3 durable Ban provenance. Nullable Product fact; uniqueness is a Kernel invariant.

ALTER TABLE bans
  ADD COLUMN IF NOT EXISTS source_proposal_id TEXT;
