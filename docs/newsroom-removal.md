# Newsroom tenant removal

The newsroom tenant — the second-tenant demo surface (news articles, entity
extraction, story clusters, editor pitches) — has been fully removed from the
product. The product now has two tenants: **orgiq** and **assessment**. This
is not a feature flag flip; every newsroom-specific file, route, table,
Cedar role, seed user, agent, and doc mention is gone.

This doc is the one place newsroom may still be mentioned, per
`docs/newsroom-removal-goal.md`. See `scripts/validate-newsroom-removal.sh`
for the automated check that nothing else does.

## What was removed, by area

### Agents (`agents/`)
- Deleted `agents/news-researcher/`, `agents/news-brief/`, `agents/news-headline/` entirely.
- Removed the three names from `agents/build-all.sh`'s `AGENTS` array.
- `agents/_shared/kb_resolver.py`: dropped the `NEWSROOM_KB_ID` env fallback and the `tenant == "newsroom"` / `slug == "newsroom"` branches.
- `agents/_shared/tenant_guard.py`: reworded the doc example that referenced `news-researcher`.
- `agents/_shared/test_prompt_source.py`: swapped a `news_brief` example name for `graph_builder` (the test was about hyphen/underscore normalization, not newsroom).
- `agents/supervisor/main.py`: removed the `reporter`/`editor` guardrail env vars (`GUARDRAIL_ID_REPORTER`/`GUARDRAIL_ID_EDITOR`), narrowed `KNOWN_TENANTS` to `{"orgiq"}`, dropped their `GUARDRAIL_ROLE_FALLBACK` entries.
- `agents/ingestion/main.py`, `agents/assessment-scorer/main.py`: dropped newsroom mentions in docstrings/comments (no behavior change — these never had newsroom-specific code paths).

### Infra (`infra/`)
- `infra/lib/agentcore-runtime-stack.ts`: removed `EXTERNAL_AGENT_NAMES` (the three imported-not-created ECR repos), the `newsroomKbId`/`documentsBucketName` props and their env injection, and the `isExternal` repo-import branch — every agent's ECR repo is now created by the stack, not imported.
- `infra/lib/agentcore-gateway-stack.ts`: removed the `newsroomKbId` prop and its `NEWSROOM_KB_ID` env injection into the KB-query Lambda; simplified the `kb_slug` tool-schema description.
- `infra/lib/authentication-stack.ts`: removed the `marcus.webb@newsroom.example` / `elena.ortiz@newsroom.example` Cognito seed users.
- `infra/lib/observability-stack.ts`: fixed a stale doc-comment example.
- `infra/bin/app.ts`: removed a dead comment about a future newsroom KB.
- `infra/lambda/gateway-tools/kb_query.py`: removed `NEWSROOM_KB_ID` and the `kb_slug == 'newsroom'` routing branch — only one KB is registered today.
- `infra/scripts/deploy.sh`: removed the stale comment explaining why the three news-* repos were absent from `ECR_REPOS` (no longer relevant — nothing imports repos anymore).
- Deleted `infra/scripts/apply-newsroom-schema.sh` (applied the now-deleted `newsroom_schema.sql`).

### Schema (`schema/`)
- Deleted `schema/newsroom_schema.sql` and its entry in `schema/load_schema.py`'s `schema_files` list.
- `schema/identity_schema.sql`: removed the `newsroom` tenant row, the `u-reporter`/`u-editor` seed users, and their `user_tenant_roles` grants.
- `schema/seed_kb_registry.sql`: removed the pending `newsroom` KB registry row.
- `schema/orgiq_kb_registry_schema.sql`: updated the `tenant` column comment (`orgiq | newsroom` → `orgiq | assessment | future`).
- Added `schema/migrations/2026-09-05-drop-newsroom.sql` — see below.

### Synth pipeline (`schema/synth/`)
- Deleted `ner.py`, `cluster.py`, `pitches.py`, `verify_newsroom.py`, and the prompt modules `prompts/news_article.py`, `prompts/ner.py`, `prompts/cluster_meta.py`, `prompts/pitch.py`.
- `schemas.py`: removed `NewsArticle(Gen)`, `ExtractedEntity`, `NERResultGen`, `ClusterMeta(Gen)`, `EditorPitch(Gen)` and their `DOC_SCHEMAS` entries.
- `generate.py`: removed the news-article planner (`plan_news_articles`, `NEWS_ANGLES`) and its imports.
- `load.py`: removed the "newsroom-side loaders" (`upsert_entities`, `upsert_article_entities`, `upsert_clusters`, `upsert_pitches`).
- `config.py`: removed `n_news_articles`, `n_pitches_per_cluster`, `s3_news_prefix`.
- `__main__.py`: removed the `ner`/`cluster`/`pitches` CLI subcommands, `news_article` from `DOC_TYPES`, and the newsroom-loading step in `cmd_load`; `cmd_all` is now a 5-stage pipeline (personas → docs → dedupe → embed → load) instead of 8.
- `__init__.py`, `aurora.py`, `README.md`, `verify_docs.py`: updated docstrings/CLI examples/doc counts (~163 docs instead of ~213).

Verified offline: `python3 -m schema.synth --help` lists `{check,snapshot,personas,docs,stats,clean,dedupe,embed,load,all}` — no `ner`/`cluster`/`pitches`, and `docs --help` no longer offers `news_article`.

### Docs / root
- `CLAUDE.md`: agent count (9→8), architecture bullet, naming conventions agent list, the "Newsroom agents" and "Newsroom is the second tenant" gotchas (removed), the identity/tenancy gotcha (reworded), "Third tenant: assessment" → "Second tenant: assessment", synth corpus doc-count.
- `README.md`: portal tenant description (two tenants: OrgIQ + Assessment), page table (Newsroom row → Assessment row).
- `CONSTITUTION.md`: agent count everywhere it appears, replaced the "News Researcher/Brief/Headline Agent" sections (7-9) with "Assessment Scorer/Drafter Agent" sections, file-tree listings, schema table.
- `docs/program-operating-model.md`: removed a changelog bullet about newsroom's editor-publish feature; fixed a "read + newsroom agents unchanged" mention.
- `docs/assessment-tenant.md`: reworded "copy the newsroom pattern" and other historical build-notes that named newsroom as the reference tenant; the isolation-log audit-trail paragraph now lists the 5 orgiq outside roles and notes where the reporter/editor logs went.
- `docs/assessment-goal.md`: isolation-audit backlog item now lists the 5 orgiq outside roles (dropped reporter/editor) and drops the `/newsroom/*` reverse-check.
- `docs/researcher-pipeline-crd.md`: this is an illustrative CRD spec for a different (platform-level) capability-declaration proof of concept that happened to use "newsroom research workflow" and `role:editor` as its example scenario — reworded to a generic research/approval workflow with `role:org-leader`.
- `docs/agentcore-preview-surface.md`: "the other seven ... three newsroom agents" → "the other six ... two assessment agents".

### Assessment validator + isolation logs
- `scripts/validate-assessment-tenant.sh`: `OUTSIDE_ROLES` narrowed from `(member sme program-owner org-leader hr-admin reporter editor)` to `(member sme program-owner org-leader hr-admin)`; dropped the `RequireTenant tenant="newsroom"` requirement from the route-tree check (now checks `assessment` + `orgiq` only); dropped `newsroom` from the cross-tenant-path-leak regex (now `/(iq|admin)(/|['"])`).
- Moved `docs/assessment-journeys/isolation/reporter.md`, `reporter.jpg`, `editor.md`, `editor.jpg` to `docs/assessment-journeys/isolation/archived-newsroom/` (they audited a role pair that no longer exists; kept for history rather than deleted, since they proved the isolation contract at the time).
- `docs/assessment-journeys/PROTOCOL.md`: checked — it only ever listed the assessment-tenant roles (assessor/lead-assessor/program-lead/admin), never reporter/editor, so no change was needed there.

### Middleware / Portal
Owned by other agents in this same removal effort (see `docs/newsroom-removal-goal.md` slices A and B). At the time of writing, `middleware/src/routes/newsroom-articles.ts`, `newsroom-beats.ts`, their providers, `middleware/src/mock/newsroom.ts`, `middleware/seeds/roles/newsroom/`, and `portal/src/pages/newsroom/**` were already deleted from the working tree.

## Database drop migration

`schema/migrations/2026-09-05-drop-newsroom.sql` drops the tables
`newsroom_schema.sql` created — `entities`, `article_entities`, `sources`,
`pitches`, `story_clusters`, `cluster_articles` (none of them were actually
named `newsroom_*`; that was shorthand in the removal goal doc, confirmed by
reading the file before deleting it) — and deletes the `newsroom` tenant row
plus the `u-reporter`/`u-editor` app_users/user_tenant_roles rows.

It deliberately does **not** drop the `documents`/`people` columns
`newsroom_schema.sql` added via `ALTER TABLE ... ADD COLUMN` (`headline`,
`subheadline`, `published_at`, `section`, `byline_person_id`, `word_count`,
`status`, `doc_type`, `people.role`) — those are additive columns on shared
tables still used by every other doc type, not newsroom-only tables.

**It is NOT auto-run.** `schema/load_schema.py` no longer registers
`newsroom_schema.sql` at all, so a freshly loaded cluster never creates these
tables in the first place — this migration exists only to clean up a cluster
that was loaded *before* this removal.

To apply it against a live cluster, see the header comment in the migration
file itself for both a Data-API snippet (using `load_schema.py`'s own
`get_cluster_info`/`execute_with_retry`/`split_sql` helpers) and a plain
`psql` invocation.

## Restoring from git

Nothing was force-deleted outside of git's history. To bring any of this
back:

```bash
# Find the commit that last touched a removed path
git log --oneline -- schema/newsroom_schema.sql          # -> c1dd588
git log --oneline -- agents/news-researcher               # last commit before deletion
git log --oneline -- portal/src/pages/newsroom             # last commit before deletion
git log --oneline -- middleware/src/routes/newsroom-articles.ts

# Restore a path from a commit before its deletion
git checkout <sha> -- schema/newsroom_schema.sql
git checkout <sha> -- agents/news-researcher agents/news-brief agents/news-headline
```

Restoring the agents/infra/schema slice alone is not sufficient to bring the
feature back — you'd also need the middleware routes/providers, the portal
pages, the Cedar roles, and to re-add `newsroom_schema.sql` to
`schema/load_schema.py`'s file list and `agents/build-all.sh`'s agent list.
