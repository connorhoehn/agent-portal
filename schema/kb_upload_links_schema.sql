-- Upload links — a way to let someone add documents without giving them access.
--
-- The alternative was handing out temporary AWS credentials. Those are bearer
-- credentials carrying everything the role can do: they cannot be scoped to a
-- single prefix per recipient, cannot be revoked individually without rotating
-- the role, and require the recipient to configure an AWS SDK rather than open
-- a browser. They also get pasted into chat.
--
-- A link is a token this table knows the hash of. The recipient never receives
-- an AWS credential of any kind — the middleware holds the only identity and
-- enforces every limit in code, so revocation is an UPDATE and the blast
-- radius of a leaked link is bounded by the columns below.

CREATE TABLE IF NOT EXISTS kb_upload_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Only the hash is stored, for the same reason passwords are hashed: a
  -- database read should not yield working links. The token is shown to its
  -- creator once, at creation, and is unrecoverable afterwards.
  token_hash    TEXT        NOT NULL UNIQUE,

  -- Which knowledge base's landing zone this drops into.
  kb_slug       TEXT        NOT NULL,

  -- Who this link was made for, in a human's words ("Finance, Q3 vendor
  -- contracts"). This is the audit trail — an anonymous link that uploaded 40
  -- files tells you nothing later.
  label         TEXT        NOT NULL,
  created_by    TEXT,

  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,

  -- Bounds enforced on every upload. A link that leaks can still only do this
  -- much.
  max_files     INTEGER     NOT NULL DEFAULT 25,
  max_bytes     BIGINT      NOT NULL DEFAULT 26214400,   -- 25 MiB per file

  files_used    INTEGER     NOT NULL DEFAULT 0,
  bytes_used    BIGINT      NOT NULL DEFAULT 0,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kb_upload_links_kb   ON kb_upload_links (kb_slug);
CREATE INDEX IF NOT EXISTS idx_kb_upload_links_live ON kb_upload_links (expires_at)
  WHERE revoked_at IS NULL;

-- What actually arrived. Kept separately from the counters so "this link was
-- used 12 times" can always be resolved into which 12 files, which is the
-- question asked when something unexpected shows up in the knowledge base.
CREATE TABLE IF NOT EXISTS kb_upload_link_files (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id      UUID        NOT NULL REFERENCES kb_upload_links (id) ON DELETE CASCADE,
  s3_key       TEXT        NOT NULL,
  filename     TEXT        NOT NULL,
  bytes        BIGINT      NOT NULL,
  content_type TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_upload_link_files_link ON kb_upload_link_files (link_id, uploaded_at DESC);
