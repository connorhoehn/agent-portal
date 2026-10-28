# DE-28 Lint for this deploy's three bug classes

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on nothing. Each check fails on the original bug if it is reintroduced,
and none needs AWS.

## Current state (read from the code, 2026-10-27)

All three bugs are fixed on `main`; each fix guards only the instance that
broke, not the class.

**1. Partial secret ARNs.** Fixed in `f26076c9`: platform-api's secrets come by
complete ARN read from SSM (`infra/lib/social-stack.ts:393-406`, comment at
`:397-399`). `Secret.fromSecretNameV2` renders `arn:…:secret:<name>` with no
random suffix; Secrets Manager reads a final `-xxxxxx` (six characters) as that
suffix, so `orgiq-realtime-jwt-secret` resolved to a secret named
`orgiq-realtime-jwt` and the task failed AccessDenied. Remaining name lookups:

- `social-stack.ts:407-409`: the three SFU secrets fall back to
  `fromSecretNameV2` when `OrgIQ-SocialMedia` is not in the app. One of them is
  `${prefix}-social-sfu-webhook-secret` (`social-media-stack.ts:87`), which
  ends in `-secret`: the exact failing shape, latent today because the
  deployed app includes the SFU stack.
- `social-media-stack.ts:648`: TURN's TLS certificate by a context-supplied
  name. Safe only if the operator's name does not end in six characters after
  a hyphen.
- `middleware-service-stack.ts:183-185` still documents "consumers import it
  with `Secret.fromSecretNameV2`", which is no longer true (stale comment).

No test or check covers the class.

**2. uuid binds as text.** Fixed in `f04834fc`: the Data API binds every
`stringValue` as text, Postgres refuses `uuid = text`, and every assessment
draft creation answered 503. The fix casts `:document`
(`middleware/src/providers/document-mapping.ts:60,81,96`,
`document-proposals.ts`), and `providers/__tests__/document-uuid-binds.test.ts`
guards three files and one parameter name. The tree's convention is an
explicit cast (`CAST(… AS uuid)` 45 times, `::uuid` 80 times, outside tests).
Two facts shape the check:

- **Column names alone are not enough.** `document_id` is uuid on the
  assessment canvas tables (`schema/assessment_schema.sql:246,259,300`) but
  TEXT on `work_item_documents` (`schema/work_item_documents_schema.sql:5`), so
  `work-documents.ts:78` binding it bare is correct. The check must know the
  table.
- **The local Postgres harness would not catch it.**
  `middleware/test-support/native-rds-preload.mjs:416-422` rewrites `:name` to
  an untyped `$n`, which Postgres infers to uuid. The Data API does not.

**3. A second CommonJS editor stack in the production bundle.** Fixed in
`ad97de16` with the `editorStackAsEsm` pre-plugin
(`portal/vite.config.ts:7-28`, wired at `:54`). Dev was never affected
because `optimizeDeps` dedupes (`:64-91`). The upstream fix (ship
realtime-modules' canvas client and TipTap adapters as ESM) is open item 2 in
`docs/aws-deploy-open-items-2026-10-27.md`. Nothing checks a build; the only
proof is the cloud document smoke (`portal/e2e/cloud-documents-smoke.spec.ts`).

There is no CI (`.github/workflows` does not exist), so "lint" here means a
check script plus a test, run like the other judges.

## Change

One script per class, collected by `scripts/validate-deploy-bug-classes.sh`
(`--quick` skips the portal build). Each follows
`scripts/check-search-writers.mjs`: a fixed rule, an `EXEMPT` list with a
reason per entry, `--json` output.

1. **`infra/test/secret-arns.test.ts`** over `synthApp()` (all stacks, with
   and without `deploySocialMedia`): walk every
   `AWS::ECS::TaskDefinition` `Secrets[].ValueFrom` and every
   `secretsmanager` resource in IAM policies. Fail any value that is an
   `Fn::Join` ending in `:secret:<literal>` with no suffix and no wildcard,
   unless it is a `Ref`/`GetAtt` to a secret in the same template or a
   `{{resolve:ssm:…}}` parameter. A source rule in the same file: any
   `fromSecretNameV2` call whose literal name, after the prefix, has a final
   hyphen segment of exactly six characters fails, with the name printed.
2. **`scripts/check-uuid-binds.mjs`**. Parse `schema/*.sql` `CREATE TABLE`
   blocks into `table → {uuid columns}`. Scan template literals in
   `middleware/src/**/*.ts` (not `__tests__`, not `mock/`). Per statement,
   resolve the tables it names (`FROM`, `JOIN`, `UPDATE`, `INSERT INTO`, with
   aliases), then fail when a uuid column is compared to, or inserted
   positionally from, a bare `:param` with no `CAST(… AS uuid)` / `::uuid`
   and no `typeHint: 'UUID'` on that parameter in the same call. It replaces
   `document-uuid-binds.test.ts`, which becomes one case of a jest test that
   runs the script.
3. **Data-API typing in the native harness.** In `native-rds-preload.mjs`,
   bind a `stringValue` with no `typeHint` as `$n::text` (and with `UUID`,
   `JSON`, `TIMESTAMP` hints as that type), matching the Data API. Any native
   acceptance run then fails the way Aurora does. Opt-out env for one release
   (`ORGIQ_NATIVE_RDS_UNTYPED=1`) in case it surfaces many failures at once.
4. **`portal/scripts/check-bundle-singletons.mjs`** after
   `vite build --sourcemap`: read every `dist/**/*.js.map` `sources`, map each
   to its package (`node_modules/<pkg>/…`), and fail if a singleton package
   (`react`, `react-dom`, `yjs`, `y-protocols`, `lib0`, `prosemirror-*`,
   `@tiptap/*`) appears from a `.cjs` file or a `/cjs/` directory, or from two
   different install paths. This is the check open item 2 describes by hand.

## Decisions owed

- **Run the portal build in the judge by default?** It is the slow step
  (`tsc && vite build`). Proposal: yes in the full run, skipped by `--quick`,
  and required before any `portal-publish.mjs`.
- **Remove the SFU secret name fallback** (`social-stack.ts:407-409`) rather
  than exempting it. Proposal: remove it; the Social stack then requires the
  SFU stack or an explicit ARN context.

## Done when

- `bash scripts/validate-deploy-bug-classes.sh` passes on `main`.
- Reverting each fix makes its check fail, shown by a fixture per class:
  `fromSecretNameV2(this, 'X', 'orgiq-realtime-jwt-secret')` in a test stack
  fails check 1; a fixture file with `WHERE document_id = :document` against
  `assessment_document_proposals` fails check 2, and the same text against
  `work_item_documents` passes; a build with `editorStackAsEsm` removed from
  `plugins` fails check 4 naming `prosemirror-view`.
- `cd infra && npm test` and `cd middleware && npx jest src/providers/__tests__`
  pass with the new tests.
- `grep -n "fromSecretNameV2" infra/lib/middleware-service-stack.ts` finds no
  stale doc comment.
