# DE-11 Knowledge Base resolution off CFN exports

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Independent. Follows the pattern `OrgIQ-AgentCoreCapabilities` already uses
for its ids (SSM by name, no import, no freeze).

## Current state (read from the code, 2026-10-27)

The backlog line is accurate on both counts, and the drift is worse than
"drifts": on a fresh deploy it is the **default** state.

- **Exports.** `OrgIQ-KnowledgeBase` exports `<prefix>-knowledge-base-id` and
  `-arn` (`infra/lib/knowledge-base-stack.ts:321-329`). They are imported by
  name in three places (`infra/bin/app.ts:227` runtime, `:352` devbox when
  `devboxOrgAccess`, `:453` middleware) and by CDK cross-stack reference
  (hash-named exports) in three more (`:131` agents IAM, `:152`
  observability, `:271` gateway). `infra/test/app-wiring.test.ts:81-98`
  pins "several consumers" as a known fact. `DataSourceId` is a plain output
  on purpose (`knowledge-base-stack.ts:331-344`).
- **Overrides are uneven.** `--context kbId=` reaches only the runtime stack
  (`app.ts:227`). The middleware stack carries the same comment but reads the
  import unconditionally (`app.ts:447-453`), so the override comment is wrong
  there. The agents' IAM grants are pinned to the old KB ARN
  (`infra/lib/agents-stack.ts:164`, `:189`), so a rebuilt KB is also a
  permissions break, not just an id break.
- **The seeded registry row is PENDING with no id.** `schema/seed_kb_registry.sql:36-53`
  seeds `default` as `bedrock_kb_id = NULL`, `status = 'PENDING'` until
  someone adopts it on `/admin/knowledge`. Agents resolve with
  `status = 'ACTIVE'` (`agents/_shared/kb_resolver.py:162-166`), so every
  fresh deploy falls back to `KB_ID`. A second seed path disagrees:
  `middleware/src/scripts/apply-kb-schema.ts:131-142` seeds the same row
  `ACTIVE` with whatever `KB_ID` the shell holds.
- **The fallback is cached for the container's life.** `resolve_kb_id` stores
  `found or KB_ID` (`kb_resolver.py:173-176`), contradicting its own
  docstring ("only successful resolutions are cached", `:8-16`). Search and
  advisor resolve at import (`agents/search/main.py:61`,
  `agents/advisor/main.py:55`), so a row adopted later is never seen until the
  runtime restarts.
- **Ingestion mixes ids.** `sync_knowledge_base` resolves a slug
  (`agents/ingestion/main.py:163-176`), but `check_ingestion_status` and
  `_get_data_source_id` use the env `KB_ID` (`:83`, `:221`), so status for a
  non-default KB is asked of the wrong one.
- **Reconcile exists, read-mostly.** `GET /api/admin/kb-registry/reconcile`
  (`routes/kb-admin.ts:318-327`, `providers/kb-reconcile.ts:304-440`) reports
  `missing`, `unregistered`, `unprovisioned`, `status-drift`, including the
  "account ACTIVE, registry PENDING" case (`:387-397`). The only repair is
  manual `POST /reconcile/adopt` (`:451-487`). It never compares the registry
  with `KB_ID` or with what the runtimes were deployed with.
- **HYBRID is pinned, its prerequisite is not checked.** Every retrieve goes
  through `vector_search_config` (`kb_resolver.py:87-100`; gateway copy
  `infra/lambda/gateway-tools/kb_query.py:23-43`; tests
  `agents/tests/test_kb_retrieve_config.py`). HYBRID needs a GIN text index.
  The CDK KB builds `to_tsvector('simple', text)` (`knowledge-base-stack.ts:244-247`);
  BFF-provisioned KBs build `to_tsvector('english', chunks)` and say Bedrock
  requires exactly that form (`providers/kb-registry.ts:408-419`). One of the
  two comments is wrong (unverified which; the CDK form measured 8/8 top-1).
  Nothing checks the index exists.
- `CLAUDE.md` listed OpenSearch Serverless under `OrgIQ-KnowledgeBase` until
  2026-10-27 (corrected); the store is Aurora pgvector and a test asserts no collection
  (`infra/test/knowledge-base-stack.test.ts:140-144`).

## Change

1. **SSM is the deploy-time source.** `OrgIQ-KnowledgeBase` writes
   `/<prefix>/knowledge-base/default/id`, `/arn`, `/data-source-id`
   (`knowledgeBaseParameterNames(prefix)`, beside `capabilityParameterNames`).
   Consumers read by name: the middleware as `ecs.Secret.fromSsmParameter`
   for `KNOWLEDGE_BASE_ID` (as `middleware-service-stack.ts:983-990` does for
   capabilities); the runtime stack via
   `ssm.StringParameter.valueForStringParameter` into `KB_ID` (a CFN
   parameter, not an export, so a rebuilt KB lands on the next runtime
   deploy); IAM grants scoped to `knowledge-base/*` in the account rather
   than one ARN. `kbId` context stays as an override on every consumer.
2. **Retire the exports in order.** Deploy each consumer on SSM first, then
   remove both `exportName`s, then delete the cross-stack references. The
   app-wiring test flips to assert **zero** KB export consumers.
3. **One seed.** Delete the `ACTIVE` insert in `apply-kb-schema.ts`. At BFF
   boot (and on `/reconcile`), when the `default` row is `PENDING` with no id
   and the SSM id exists live, adopt it automatically with
   `adoptKnowledgeBase`. Any other drift stays a human decision, as now.
4. **Resolver correctness.** `resolve_kb_id` caches only registry hits, with
   a 5-minute TTL so an adoption reaches running agents; search and advisor
   resolve per call. Every log line names the source (`registry` or
   `env-fallback`). Ingestion uses the resolved id for status and data source.
5. **Reconcile the rest.** `reconcileKnowledgeBases` adds drift kinds
   `env-mismatch` (registry `default` id differs from the BFF's
   `KNOWLEDGE_BASE_ID` / SSM value) and `hybrid-unready` (no GIN `tsvector`
   index on the row's `aurora_table`, from `pg_indexes`), plus the latest
   ingestion job state it already reads (`syncState`). Pick one index form
   for both provisioners after checking which Bedrock accepts.

## Decisions owed

- **Auto-adopt the default row?** Proposal: yes, only the PENDING-no-id case
  above; it is the state every deploy starts in and has one right answer.
- **Runtime KB id at deploy or at call time?** Proposal: deploy time
  (`valueForStringParameter`), since agents read the registry at call time
  anyway; call-time SSM reads add a grant and a hop for no new case.
- **Which text-index form is canonical.** Needs one Bedrock test against a
  scratch KB; proposal: whichever passes, applied to both provisioners.

## Done when

- `cd infra && npx jest test/app-wiring.test.ts` asserts no stack imports a
  KnowledgeBase export, and `test/knowledge-base-stack.test.ts` asserts the
  three SSM parameters and no `Export` on KB outputs.
- `cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_kb_resolver`
  covers: env fallback is not cached; a registry hit expires after the TTL.
- `cd agents/tests && ../../.venv-synth/bin/python -m unittest test_kb_retrieve_config`
  stays green.
- `cd middleware && npx jest src/providers/__tests__/kb-reconcile` covers
  `env-mismatch`, `hybrid-unready` and the auto-adopt of a PENDING default row.
- `grep -n "'ACTIVE'" middleware/src/scripts/apply-kb-schema.ts` finds no seed.
- `scripts/validate-mock-floor.sh` stays green (mock registry gains one
  `hybrid-unready` row, derived, not stated).
