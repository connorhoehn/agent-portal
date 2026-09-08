-- 2026-09-05-drop-newsroom.sql
--
-- Drops the newsroom tenant's data: the tables `newsroom_schema.sql` created
-- (none of them are actually prefixed `newsroom_*` — see the table list below,
-- confirmed against the deleted file before it was removed) and the identity
-- rows for the newsroom tenant and its two seed users (u-reporter, u-editor).
--
-- NOT auto-run by schema/load_schema.py (which no longer registers
-- newsroom_schema.sql at all — a fresh cluster never creates these tables in
-- the first place). This migration exists only to clean up a cluster that was
-- loaded BEFORE this removal, i.e. one that already has these tables/rows.
--
-- Deliberately left alone: the `documents.headline/subheadline/published_at/
-- section/byline_person_id/word_count/status/doc_type` and `people.role`
-- columns that `newsroom_schema.sql` added via `ALTER TABLE ... ADD COLUMN`.
-- Those are additive columns on shared tables (not newsroom-only tables), the
-- original file was explicitly "no DROP, no destructive changes", and other
-- code paths may read/write them (e.g. `doc_type` on documents is not unique
-- to newsroom rows) — dropping them is out of scope for this migration. They
-- are simply unused for any newsroom row after this runs.
--
-- How to apply:
--   Option A — Data API, using load_schema.py's own helpers
--   (get_cluster_info, execute_with_retry, split_sql):
--     python3 -c "
--       import boto3
--       from schema.load_schema import get_cluster_info, execute_with_retry, split_sql
--       cluster_arn, secret_arn, db_name = get_cluster_info()
--       rds = boto3.client('rds-data', region_name='us-east-1')
--       sql = open('schema/migrations/2026-09-05-drop-newsroom.sql').read()
--       for stmt in split_sql(sql):
--           if stmt.strip().upper() not in ('BEGIN', 'COMMIT'):
--               execute_with_retry(rds, cluster_arn, secret_arn, db_name, stmt)
--     "
--   (the Data API auto-commits each execute_statement call — BEGIN/COMMIT
--   above are for psql; skip them when driving statements one at a time
--   through the Data API, as the snippet above does.)
--
--   Option B — psql, if you have direct network access to the cluster:
--     psql "$DATABASE_URL" -f schema/migrations/2026-09-05-drop-newsroom.sql
--
-- Restoring from git if this was ever run in error:
--   git log --oneline -- schema/newsroom_schema.sql   # find the sha before deletion
--   git checkout <sha>~1 -- schema/newsroom_schema.sql schema/identity_schema.sql
--   (then re-run schema/load_schema.py, which re-registers newsroom_schema.sql
--   only once it is un-deleted from schema/load_schema.py's list too)

BEGIN;

-- ── Newsroom feature tables (article_entities/cluster_articles/sources are
-- leaf tables that FK into entities/story_clusters/documents; CASCADE is
-- belt-and-suspenders in case a future FK is added in a different order) ──
DROP TABLE IF EXISTS article_entities CASCADE;
DROP TABLE IF EXISTS cluster_articles CASCADE;
DROP TABLE IF EXISTS sources CASCADE;
DROP TABLE IF EXISTS pitches CASCADE;
DROP TABLE IF EXISTS story_clusters CASCADE;
DROP TABLE IF EXISTS entities CASCADE;

-- No views were defined by newsroom_schema.sql (kept as a no-op guard in
-- case one was added later out-of-band).
-- DROP VIEW IF EXISTS <name> CASCADE;

-- ── Newsroom tenant + its two seed users ──────────────────────────────────
-- Order matters: user_tenant_roles FKs both app_users and tenants.
DELETE FROM user_tenant_roles WHERE tenant_id = 'newsroom';
DELETE FROM user_tenant_roles WHERE user_id IN ('u-reporter', 'u-editor');
DELETE FROM app_users WHERE id IN ('u-reporter', 'u-editor');
DELETE FROM tenants WHERE id = 'newsroom';

COMMIT;
