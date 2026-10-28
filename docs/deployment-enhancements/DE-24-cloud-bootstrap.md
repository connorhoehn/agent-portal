# DE-24 Cloud environment bootstrap

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Feeds DE-21: the gate's browser tiers need the logins and fixtures this spec
creates. Pairs with DE-20 (schema migrations) and DE-11 (KB ids).

## Current state (read from the code, 2026-10-27)

**Cognito users exist, but none can sign in until someone sets a password.**
`OrgIQ-Authentication` creates 24 `CfnUserPoolUser`s with
`messageAction: 'SUPPRESS'` and no password
(`infra/lib/authentication-stack.ts:108-162`). They start in
`FORCE_CHANGE_PASSWORD`, and the stack's header says to set passwords by hand
with `admin-set-user-password --permanent` (`:26-27`). The pool policy
requires 12 or more characters with upper case, lower case and a digit
(`:60-66`). The pool is `DESTROY` (`:68-69`), so rebuilding the auth stack
resets every user. Only Farah and Mira have permanent passwords today
(open-items doc). Any other user who reaches the hosted UI gets the
new-password page, and `cloudSignIn`'s `waitForURL` times out on it
(`portal/e2e/cloudSession.ts:21`).

**The directory side is already seeded and links itself.**
`schema/identity_schema.sql:67-121` inserts the same 24 emails into
`app_users`, and `:122+` grants the tenant roles. The callback looks a user
up by `external_sub` and falls back to email, then links the new sub
(`middleware/src/routes/auth.ts:118-124`,
`middleware/src/providers/identity.ts:449-458`). After a pool rebuild the
first login therefore relinks by email, and the directory needs no extra
step.

**Demo identities do not exist in the cloud.** `realSession.ts` (picker
logins, `demoSession`, clones; `portal/e2e/realSession.ts:9-15,31-33`) works
only in demo mode. The picker returns 403 otherwise
(`middleware/src/routes/session.ts:217-227`). In the cloud, a "demo identity"
can only be a Cognito user with a known password. The only place such a
password lives today is a hand-kept `~/.orgiq-aws-test/logins.txt`, mode 600
(open-items doc `:28`). That file is not present under this checkout's home.

**There is no knowledge source.** Assessment's tree is whatever is in
`assessment_knowledge_sections`/`_nodes` (`assessment-aurora.ts:1072-1090`),
plus a synced Confluence section, but only when `ASSESSMENT_SOURCE_URL` and
`ASSESSMENT_SOURCE_SECRET` are set (`providers/document-source.ts:11`,
`providers/assessment.ts:3215-3223`). Those variables come from the
`documentWorkspace` config's optional `source`, described as a "separately
deployed, authenticated accelerator source adapter"
(`infra/lib/document-workspace.ts:24-25,166-170`).
`scripts/docker/document-workspace-push.mjs` never writes `source`. No file
under `schema/` inserts a knowledge section: `workspace_drafts` is created on
demand by `providers/document-drafts.ts:39`. So a fresh cloud tree is empty,
which is why the document spec creates its own page
(`cloud-documents-smoke.spec.ts:33-39`). Locally the tree comes from the mock
fixture (`middleware/src/mock/assessment.ts:4814`).

**The synthetic corpus is a manual step, and it can report success without
indexing anything.** `python -m schema.synth all` runs personas, docs, dedupe,
embed and load (`schema/synth/__main__.py:230-252`). `load` writes documents,
mentions, S3 and node embeddings, then starts one ingestion job
(`:184-206`). It does not wait for that job to finish. If the KB stack
outputs are missing, `trigger_kb_sync` logs a warning and returns `None`
(`schema/synth/load.py:188-196`), and `load` still exits 0. CLAUDE.md says this
"used to" happen; it still does. A full regeneration costs about $0.45 in
Bedrock and nothing on cache hits (`schema/synth/README.md`). `cache/` and
`staged/` are gitignored (`schema/synth/.gitignore:1-2`), so a fresh clone
has to regenerate. The repo does not record whether the corpus was loaded
into the current cloud stack.

## Change

**`scripts/cloud-bootstrap.mjs`** (Node, AWS CLI through `execFile`,
idempotent, no npm deps), with three subcommands:

1. **`users [--only a@x,b@y] [--rotate]`**
   - Lists the pool (`UserPoolId` output) and joins it to `app_users` by email
     over the Data API.
   - For each user in `FORCE_CHANGE_PASSWORD`, or missing from the logins
     file, or named in `--rotate`, it generates a password from
     `crypto.randomBytes`, sized to the pool policy. It sets the password with
     `admin-set-user-password --permanent`, passing the password through
     `--cli-input-json file://<mode-600 temp>` and never as an argv value
     (argv is visible in `ps`), and deletes the temp file in a `finally`.
   - It writes `<email> <password>` lines to
     `${ORGIQ_CLOUD_LOGINS:-~/.orgiq-aws-test/logins.txt}`:
     - the directory is created mode 700, and the file is replaced
       atomically (temp file, mode 600, `rename`);
     - lines for users not being changed are kept;
     - the script refuses a path inside the repo.
   - It never prints a password; it prints `email → CONFIRMED (new|kept)`.
   - With no `--only`, it bootstraps all 24, which covers one login per
     tenant role (`identity_schema.sql:122+`).
2. **`data [--corpus cached|generate|skip]`**
   - Runs `schema/apply_all_seed.py` (already idempotent).
   - Applies a new `schema/seed_assessment_knowledge.sql`. A generator
     derives it from the mock fixture, `knowledgeSectionsFixture` and its
     docs, so the cloud tree and `dev:mock` share one source. Like
     `schema/seeds/generate_program_seed.py`, it is regenerated, never
     hand-edited, and registered in `apply_all_seed.py`.
   - Then `schema.synth load`. The default `cached` loads only when
     `staged/` holds documents. `generate` spends Bedrock and needs
     `--yes-spend`.
   - Waits for the ingestion job with `get-ingestion-job` until `COMPLETE` or
     `FAILED`, bounded at 20 minutes.
3. **`check`** (read-only; DE-21 runs it in tier 1). Each of these lines is
   pass or fail:
   - Cognito users per status;
   - Cognito emails without an `app_users` row, and the reverse;
   - each tenant role with no bootstrapped login;
   - `people` and `documents` counts;
   - non-draft knowledge sections;
   - the latest ingestion job's status;
   - the `knowledge_bases` row being `ACTIVE`;
   - one `Retrieve` (HYBRID, per `kb_resolver.vector_search_config`) for a
     seeded document title returning that document in the top 3.

**`schema/synth/load.py`**: `trigger_kb_sync` raises when the stack outputs
or KB ids are missing, unless `--skip-kb-sync` was given, so `load` exits
non-zero.

**Fixtures for DE-21.** `cloud-bootstrap.mjs data` runs DE-21's
`--seed-fixtures` pass once. That creates the `Cloud call smoke` room and the
`Cloud document smoke` draft if they are missing. Every later gate reuses
them.

## Decisions owed

- **Who gets a password.** All 24, or only the five logins the gate uses?
  Proposal: all 24 in one file, because journey walks need the whole cast.
  Rotate with `--rotate` after sharing a file.
- **Corpus spend.** Should a fresh environment regenerate the corpus (about
  $0.45 of Bedrock), or must the operator carry `staged/` over? Proposal:
  `cached` by default, `generate` only with `--yes-spend`, never from the
  gate.
- **The synced Confluence section.** Deploying a source adapter is outside
  this repo. Proposal: the cloud seeds local sections only, and the synced
  section stays a local and mock feature until an adapter exists.
- **Pool retention.** The pool is `DESTROY` today. Proposal: keep it for this
  demo account, because re-running `users` restores the logins and the BFF
  relinks by email.

## Done when

- Unit tests (`node --test`):
  - generated passwords satisfy the pool policy;
  - the logins writer creates the directory 700 and the file 600, keeps
    untouched lines, refuses a path inside the repo, and its log output
    contains no password;
  - `admin-set-user-password` is never called with the password in argv.
- A Python test shows `trigger_kb_sync` raises on missing outputs and `load`
  exits non-zero; `--skip-kb-sync` still exits 0.
- `seed_assessment_knowledge.sql` is regenerated from the fixture with no
  diff, and `scripts/validate-mock-floor.sh` stays green.
- Live, after `node scripts/cloud-bootstrap.mjs users && … data`:
  - `node scripts/cloud-bootstrap.mjs check` exits 0 with zero
    `FORCE_CHANGE_PASSWORD` in the bootstrapped set;
  - every tenant role has a login;
  - `GET /api/assessment/knowledge/tree` returns at least one section other
    than `workspace_drafts`;
  - the ingestion job is `COMPLETE`.
- Running `users` and `data` a second time changes no password, writes no
  rows (the seed counts are unchanged) and creates no second smoke room.
