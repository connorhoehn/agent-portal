-- Local compute — a developer's own machine as a fleet participant.
--
-- Two tables, and deliberately only two. The NODE (a paired machine) is
-- durable: it holds a long-lived token hash, and losing it on a middleware
-- restart would force every laptop to re-pair. The SESSIONS running on a node
-- are ephemeral presence — they live in middleware memory
-- (lib/local-compute-fleet.ts, same posture as the devbox fleet registry) and
-- re-announce within one heartbeat after a restart, so persisting them would
-- only create rows that lie about liveness.
--
-- The token is never stored: `token_hash` is sha256(token), computed at
-- pairing time. Presence writes authenticate by presenting the token; the
-- middleware hashes and looks it up — the same shape as a personal access
-- token, because that is what it is.
--
-- See docs/local-compute-presence.md for the full design.

CREATE TABLE IF NOT EXISTS compute_nodes (
  id            TEXT PRIMARY KEY,            -- host id minted by the plugin (stable per machine)
  owner_id      TEXT NOT NULL,               -- app_users sub; bound at pairing, never changes
  label         TEXT NOT NULL,               -- "connor-macbook"
  platform      TEXT,                        -- "darwin/arm64"
  token_hash    TEXT NOT NULL UNIQUE,        -- sha256(nodeToken), hex; token itself never stored
  accept_jobs   BOOLEAN NOT NULL DEFAULT FALSE, -- opt-in to the job dispatcher (P2); default off
  local_models  JSONB NOT NULL DEFAULT '[]', -- models the machine can serve offline
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ,                 -- bumped by announce/heartbeat
  revoked_at    TIMESTAMPTZ                  -- soft revoke: a revoked token 401s but the row remains for audit
);

CREATE INDEX IF NOT EXISTS compute_nodes_owner_idx ON compute_nodes (owner_id);

-- Pairing codes: short-lived, single-use. Minted by an authenticated browser
-- session (the cookie cannot leave the browser, so the machine claims a code
-- instead); claiming one creates the node and returns its token exactly once.
CREATE TABLE IF NOT EXISTS compute_pairing_codes (
  code        TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  claimed_at  TIMESTAMPTZ
);
