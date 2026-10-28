# DE-20 Automated schema migrations

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Unblocks the page-thread migration (`docs/aws-deploy-open-items-2026-10-27.md`
§3) and every later "additive schema registered in both loaders" item, DE-30's
`spend_entries` among them.

## Current state (read from the code, 2026-10-27)

There is no migration ledger. Schema reaches Aurora by hand:

- `schema/load_schema.py` re-executes every statement of every registered
  file on each run (`schema_files`, `:170-302`), treats "already exists" as
  success (`:328`) and exits 1 only on a genuine failure. Nothing records what
  ran, when, from which file version, or by whom. `infra/scripts/deploy.sh`
  never calls it.
- **"Both loaders"** in CLAUDE.md are `load_schema.py` and
  `schema/apply_all_seed.py` (`FILES`, `:24-74`), which repeats eleven of
  those files around the seeds so a seed-only run works, and alone loads
  `environments_schema.sql` (it seeds FK rows, `load_schema.py:270-278`). A third hand copy of the
  order lives in `middleware/src/lib/__tests__/migrate-work-comments-postgres.test.ts:39-47`,
  and `schema/apply-schema.sh` plus eight `infra/scripts/apply-observability-*.sh`
  are older single-file appliers.
- "Additive" is a convention, not a property. Registered files carry data
  rewrites that run again on every load: `orgiq_work_items_schema.sql:224`
  and `:227` (`UPDATE work_items SET type = 'story' …`, `parent_id = NULL`),
  `identity_schema.sql:61`, `work_item_key_schema.sql:32`, and
  drop-and-re-add constraint blocks (`assessment_schema.sql:381`,
  `access_schema.sql:125`, `:197-200`). They are idempotent, so re-running is
  safe, but they are data changes no one approves per run.
- The one non-idempotent change, `schema/migrations/2026-09-05-drop-newsroom.sql`,
  is deliberately never run by a loader (its header) and has no record of
  whether any cluster ran it.
- The page-thread migration is a **data move into the chat store**, not SQL:
  `npx tsx src/lib/migrate-work-comments.ts [--dry-run] [--report out.json]`
  (`middleware/src/lib/migrate-work-comments.ts:23-25`). Its
  `work_item_comment_migrations` table is that job's per-row claim ledger
  (`schema/work_item_comment_migration_schema.sql:10-17`), not a schema
  ledger. It has not run; it needs the user's sign-off (open items §3).
- `deploy.sh` runs one `cdk deploy` over all target stacks (`:470`), so there
  is no point between "Aurora exists" and "the new BFF starts" for a laptop
  step to run inside a single invocation.

**Applied state:** open items §3 records the three additive schemas applied
and verified on 2026-10-27; only the page-thread data migration is
outstanding (CLAUDE.md was corrected to say so the same day). Nothing records
that in the database, which is the gap the ledger closes.

## Change

1. **One manifest.** `schema/manifest.json` lists every file in load order
   with a `kind`: `repeatable` (today's idempotent files, re-applied when
   their checksum changes), `versioned` (run once, inside a Data API
   `BeginTransaction`/`CommitTransaction` pair; Postgres DDL is transactional),
   `data` (moves or rewrites rows; needs approval) or `seed` (demo data, never
   run by a deploy). Both loaders and the Postgres test suites read it, so a
   new file is registered once.
2. **The ledger.** `schema/schema_migrations_schema.sql`, first in the
   manifest: `id`, `kind`, `checksum`, `status` (`planned`, `approved`,
   `applied`, `failed`), `dry_run_report JSONB`, `dry_run_sha`,
   `approved_by`, `approved_at`, `applied_by`, `applied_at`, `duration_ms`.
   Identities come from `sts get-caller-identity`, never from a flag.
3. **The runner.** `python -m schema.migrate status|plan|approve|apply`,
   reusing `split_sql`, `warm_up` and `execute_with_retry` from
   `load_schema.py`. A `data` entry names its dry-run and apply commands (SQL,
   or an external command such as the tsx CLI with `--report`).
   - `plan` runs every pending dry-run and stores the report and its sha.
   - `approve <id> --sha <dry_run_sha>` records the approver, refused when the
     sha is not the latest plan's.
   - `apply` runs repeatable and versioned entries freely and a `data` entry
     only when approved; it re-runs the dry-run first and stops if the
     report differs beyond the entry's tolerance.
4. **Deploy integration.** When `OrgIQ-Aurora` is live, `deploy.sh` runs
   `migrate apply --schema-only` before `cdk deploy`, so the new BFF starts on
   the new schema. An unapplied `data` entry marked `before: middleware` stops
   a deploy that includes `OrgIQ-MiddlewareService` and prints the
   `plan`/`approve`/`apply` commands. On a fresh account the step runs after
   `cdk deploy` creates Aurora. `DEPLOY_MIGRATE=false` skips it.
5. **Page-thread as the first `data` entry,** reproducing CLAUDE.md's order:
   ledger schema (repeatable, already applied), dry-run (`plan`), sign-off
   (`approve`), migrate (`apply`), then the BFF deploy.
6. **Baseline.** The first `apply` on an existing cluster runs every
   repeatable file once, as `load_schema.py` does today, and records it.
   `drop-newsroom` enters as a `data` entry and needs `approve` like any other.

## Decisions owed

- **Laptop step or CloudFormation custom resource?** Proposal: laptop, in
  `deploy.sh`. A Lambda inside the stack graph would order itself, but it
  cannot run the tsx chat-store migration and cannot wait for a human.
- **Report tolerance between approval and apply.** Rows keep arriving on a
  live cluster. Proposal: approval holds for 24 hours, and apply refuses if
  the affected-row count grew by more than 5% or any new table appears.
- **Retire `apply-schema.sh` and the `apply-observability-*.sh` scripts?**
  Proposal: yes, once the manifest covers their files (all eight already
  appear in `load_schema.py`).

## Done when

- `cd schema && ../.venv-synth/bin/python -m unittest test_migrate test_deployment_prerequisites`
  passes, with a fake executor covering: a changed checksum re-applies a
  repeatable file; a versioned entry runs once; a `data` entry is refused
  without approval and with a stale sha; a failure records `failed` and exits
  non-zero.
- `grep -c "_schema.sql'" schema/load_schema.py schema/apply_all_seed.py`
  prints 0 for both (the lists come from the manifest).
- `cd middleware && npx jest src/lib/__tests__/migrate-work-comments-postgres.test.ts src/providers/__tests__/work-documents-postgres.test.ts`
  passes with the schema order read from the manifest.
- A `infra/test/deploy-config.test.ts` source check pins the migrate step
  before `cdk deploy` in `deploy.sh`.
- Cloud (once credentials work): `python -m schema.migrate status` lists every
  manifest entry `applied` with matching checksums, and the page-thread row
  shows `approved_by` and an `applied_at` earlier than the BFF task
  definition's registration.
