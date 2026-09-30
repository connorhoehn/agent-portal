-- The social tenant's middleware-owned tables (docs/social-tenant-design.md §4.4).
--
-- Chat state itself — messages, membership, read receipts, the per-user
-- conversations index — is NOT here: it lives in DynamoDB (chat-messages /
-- chat-members / chat-reads / chat-conversations, OrgIQ-Social) behind
-- realtime-modules' DynamoChatStore. This file holds what the chat store has
-- no place for: the channel DIRECTORY, i.e. the name, description and
-- privacy of each `social:ch:<slug>` channel, so the Channels page can list
-- channels a user has not joined yet. Membership of a channel is its
-- chat-members rows, never a column here.
--
-- Idempotent: safe to re-run (schema/load_schema.py loads it after identity).

CREATE TABLE IF NOT EXISTS social_channels (
  tenant       TEXT        NOT NULL DEFAULT 'social',
  slug         TEXT        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name         TEXT        NOT NULL,
  description  TEXT,
  privacy      TEXT        NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private')),
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, slug)
);
