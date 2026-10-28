-- Dry run for 2026-09-05-drop-newsroom.sql (a DE-20 `data` entry).
-- One row per thing the migration would remove: (name, rows). Missing tables
-- simply produce no row, so a cluster that never had newsroom reports 0.
SELECT 'table:' || c.relname AS name,
       (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS rows
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r'
   AND n.nspname = ANY (current_schemas(false))
   AND c.relname IN ('article_entities', 'cluster_articles', 'sources', 'pitches', 'story_clusters', 'entities')
UNION ALL
SELECT 'user_tenant_roles:newsroom', count(*) FROM user_tenant_roles
 WHERE tenant_id = 'newsroom' OR user_id IN ('u-reporter', 'u-editor')
UNION ALL
SELECT 'app_users:newsroom', count(*) FROM app_users WHERE id IN ('u-reporter', 'u-editor')
UNION ALL
SELECT 'tenants:newsroom', count(*) FROM tenants WHERE id = 'newsroom';
