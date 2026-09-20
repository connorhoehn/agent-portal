# September 19 checkpoint deployment prerequisites

This is the upgrade path for `f837bd68` relative to `818b6baa`. These commands
have not been run against AWS or a live database during the audit. Local tests
cover loader behavior and wiring; deployment needs its own recorded evidence.
Use the repository's existing AWS account/profile instructions in `CLAUDE.md`.

## Order

1. Deploy the Aurora stack if its `orgiq-aurora-readonly-credentials` secret and
   reader-secret export do not exist. This creates the secret, not a PostgreSQL
   login with its password. Do not activate updated read agents/gateway yet.
2. Back up and preflight the existing database, then apply
   `python3 schema/load_schema.py`. The loader locates files relative to itself
   and returns failure if required files or statements fail. It includes
   `assessment_schema.sql` after its base dependencies. DDL is applied statement
   by statement, not as one transaction for the entire schema; resolve failures
   before deploying middleware. This command does not replay demo seed data.
3. Run `python3 schema/apply_all_seed.py --readonly-role-only` after graph tables
   exist. It applies the explicit reader grants, sets the password from the
   configured secret, and checks privileges. Missing credentials return failure.
   The option works from any working directory when the script path is resolved.
   Do not use the ordinary seed command merely to upgrade reader credentials:
   that command also loads the curated demo dataset.
4. Build/push the updated shared agent base and assessment/search/advisor images
   using the existing image runbook, then deploy the matching runtimes. Deploy
   the gateway tools with their dedicated reader permissions. Search/advisor
   must have `AURORA_READONLY_SECRET_ARN` and `APP_ENV=production`; the former
   `readOnlyGraphRole=false` escape hatch is rejected. The gateway's
   `AURORA_SECRET_ARN` intentionally points to the reader secret. Follow
   [reader-role deployment](readonly-graph-role.md) for role authentication and
   engine-level checks; an environment variable alone is not proof of grants.
5. Roll middleware only after the schema and matching assessment runtimes are
   ready. The ECS stack injects `ASSESSMENT_RUN_COMPLETE_SECRET` from Secrets
   Manager and has runtime invoke/list and Data API transaction permissions.
   External callback senders need that secret; the internal dispatcher calls
   completion directly and does not send an HTTP callback. Production callbacks
   fail with 503 if unconfigured and reject an incorrect configured secret.
   For the full fleet, follow the existing [machine-callback rollout runbook](agentcore-preview-surface.md#6a-machine-callback-auth-secrets--operator-runbook):
   agent images must support the headers before enforcing secrets, and runtime
   environment values must match the middleware's secrets. This upgrade order
   does not remove that coordinated rollout or its documented blackout window.

## Assessment preflight and migration behavior

Check for legacy comments that lack a node before changing the foreign key:

```sql
SELECT c.id AS comment_id, c.doc_id
FROM assessment_knowledge_comments c
LEFT JOIN assessment_knowledge_nodes n ON n.id = c.doc_id
WHERE n.id IS NULL;
```

If this returns rows, reconcile their document/node ownership explicitly using
the existing document metadata. Do not delete comments or fabricate node
parents to make the migration pass. Existing local documents were not required
by the old schema to have a corresponding node, so a populated legacy database
can expose this case even though normal application writes create both.

The comment FK replacement is one dollar-quoted `DO` statement. PostgreSQL
validates the replacement inside that statement: failure rolls back the drop,
retaining the old constraint and all rows. The loader's other statements may
still have applied, so a failed migration is not an all-schema rollback.
Fresh databases create nodes before comments. After a successful upgrade,
comments can reference both local documents and synced pages through nodes.

`dispatch_payload JSONB` and `dispatch_claimed_at TIMESTAMPTZ` are additive,
nullable columns on `assessment_runs`; no fabricated inputs are backfilled.
Queued payloads survive a BFF restart. Claimed/interrupted runs expire as failed
after twenty minutes instead of invoking the model again. Old running records
without a payload also expire; old completed records stay completed. Review
existing running work before rollout, since legacy callbacks/worker versions
can still be active during a mixed-version deployment. Pause launches and drain
or explicitly stop old runs before replacing the middleware fleet.

A stopped run prevents later persisted scoring but does not immediately cancel
remote inference. Do not roll back to a pre-transaction worker while new runs
are active. The additive columns can remain for a code rollback. Reverting the
comment FK to the old document table requires checking for new synced-page
comments first; a blind reversal will fail or discard supported relationships.

## Acceptance on the deployed environment

Record the schema loader and reader bootstrap exit statuses. Inspect the
comment constraint target and both dispatch columns. Verify a reader-secret
Data API SELECT succeeds and writes fail; the bootstrap's administrator-side
privilege query does not itself establish successful reader authentication.

Launch one scoring run using a committed submission and one document command
with explicit source text. Check claimed/terminal state, selected-envelope
provenance, score history and draft output; repeat a completion callback and
confirm 409 without duplicate history. Test stop/completion ordering. Post and
reload a comment on a synced page. Observe worker errors and bounded expiry on
a controlled interrupted run. Keep this live acceptance separate from local
transaction-fake tests and mock browser journeys.

## Comment reply migration

Before deploying durable quote replies, apply the additive `parent_id TEXT`
self-reference on `assessment_knowledge_comments` in `assessment_schema.sql`.
Existing comments retain NULL parents. The application validates same-document,
undeleted parents and locks them while inserting replies. Edits cannot reparent
comments. Soft deletes preserve child replies; the self-reference uses NO ACTION
rather than cascading an individual parent's removal through the conversation.
This migration has not been applied to a live database. Deployment acceptance
must include posting/reloading a reply and deleting its parent while preserving
the reply and rendering a deleted-parent quote.
