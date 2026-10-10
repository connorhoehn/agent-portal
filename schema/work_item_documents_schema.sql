-- Apply after orgiq_schema.sql and orgiq_work_items_schema.sql.
-- A saved association carries document identity, never a copied title/URL.
CREATE TABLE IF NOT EXISTS work_item_documents (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  linked_by TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (work_item_id, document_id)
);
CREATE INDEX IF NOT EXISTS work_item_documents_document_id_idx
  ON work_item_documents(document_id);
COMMENT ON TABLE work_item_documents IS
  'Explicit work context associations to the OrgIQ ingested corpus. Source content retains its own permissions.';
