-- Search definitions belong to a user and tenant. No result/transcript copies.
CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY,
  owner_sub text NOT NULL,
  tenant_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS saved_searches_owner_updated_idx
  ON saved_searches (tenant_id, owner_sub, updated_at DESC);
