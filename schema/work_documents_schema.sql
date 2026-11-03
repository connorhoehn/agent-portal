-- Work workspace documents (2026-11-02): pages people write INSIDE an
-- initiative — the Docs tab's "New › Document" and the Discussion's /doc
-- "Save as document" — as opposed to the ingested corpus records in
-- `documents`, which only get LINKED to work items (work_item_documents).
-- Additive: apply after orgiq_schema.sql and orgiq_work_items_schema.sql.
-- `kind` is 'page' today; 'whiteboard' is reserved for the canvas slice.
CREATE TABLE IF NOT EXISTS work_documents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  work_item_id  TEXT REFERENCES work_items(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'whiteboard')),
  markdown      TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS work_documents_project_idx ON work_documents (project_id, updated_at DESC);
