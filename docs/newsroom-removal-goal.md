# Goal: get rid of the newsroom tenant

`scripts/validate-newsroom-removal.sh` is the judge: it exits 0 only when
no reference to the newsroom tenant survives anywhere it can execute, the
two remaining tenants still pass their own validators, and the audit trail
shows the tenant gone from the picker, the shell, the routes and the API.
No `npm install`. Do not commit. Delete tracked files with `git rm` (or
plain `rm` — git tracks the deletion either way); the deletion is reversible
through git, so be thorough rather than cautious.

## Status (2026-09-05 16:10) — done

`scripts/validate-newsroom-removal.sh` (full): every line ✓ except the
wrapped distillation validator, which is only waiting on its own journey
freshness sweep (in flight, unrelated to the removal). Removed: 3 agent
dirs, 13 portal page files, 7 middleware files + 2 Cedar seeds, the schema
file and its loader entry, 8 synth stage/prompt files, 1 infra script;
edited ~60 files across middleware/portal/agents/infra/schema/docs. Proof as
u-operator (`docs/newsroom-removal-journey.md`): picker = Org + Assessment,
`/newsroom*` → the app's not-found page, `/api/newsroom/articles` → 404,
0 palette entries, roster has no reporter/editor. Closing numbers:
middleware 110 suites / 1675 tests, portal 378 tests, both `tsc` clean,
build green, assessment validator ALL CHECKS PASS, CDK synth produces all
18 templates offline (the two credential-bound lookups excepted). The DB
drop migration `schema/migrations/2026-09-05-drop-newsroom.sql` is written
and documented, not applied.

## What "gone" means

The product has two tenants after this: **orgiq** and **assessment**. The
newsroom tenant, its three agents, its Cedar roles, its seed users, its
schema loader entry, its pages, its nav, its palette entries, its feature
flag, its infra, its synth-corpus stages and its mock fixtures are removed —
not flagged off, not commented out. One place may mention it afterwards:
`docs/newsroom-removal.md`, which records what was removed, the database
drop migration and how to restore from git if ever needed.

## Inventory (what the grep found, 2026-09-05)

| area | what |
|---|---|
| middleware/src | `routes/newsroom-articles.ts`, `routes/newsroom-beats.ts`, `providers/newsroom-articles.ts`, `providers/newsroom-beats.ts`, `mock/newsroom.ts`, the `newsroom` mounts in `index.ts`, `TENANTS`/`ROLES_BY_TENANT`/`permissiveGrants` in `lib/session.ts`, role registry + `CAPABILITY_ACTIONS` entries, agent proxy allow-lists for `news-*`, identity fallback users `u-reporter`/`u-editor`, every test that mentions newsroom (36 files) |
| middleware/seeds | `roles/newsroom/reporter.cedar`, `editor.cedar`, `schema.json` entity/role entries |
| portal/src | `pages/newsroom/**`, the `newsroom` route tree + `NEWSROOM_ENABLED` in `App.tsx`, `lib/features.ts`, `Layout.tsx` nav items/groups/tenant labels, `portalCommands.ts` pages, `SelectContextPage.tsx` roster + tenant cards, `lib/auth.tsx` `Tenant` type, `Breadcrumbs.tsx`, `tenantCaches.ts`, tests (33 files) |
| agents | `agents/news-researcher`, `news-brief`, `news-headline`, their entries in `build-all.sh`, `_shared` references (prompt names, instrumentation service names), the supervisor's tenant/role branches for reporter/editor |
| infra | runtime + ECR + execution-role entries for the three agents (`OrgIQ-AgentCoreRuntime`, `OrgIQ-Agents`), Cognito seed users `u-reporter`/`u-editor` (`authentication-stack.ts`), `destroy.sh`'s repo list, `bin/` context, the span-projector lambda's service names if any |
| schema | `newsroom_schema.sql` (delete) + its `load_schema.py` entry; `identity_schema.sql` seed rows for the newsroom tenant/users/grants; `seed_kb_registry.sql`/`orgiq_kb_registry_schema.sql` newsroom KB rows; `schema/synth/*` newsroom stages (entities, clusters, pitches, ~50 news articles) and their CLI subcommands; a NEW `schema/migrations/2026-09-05-drop-newsroom.sql` with `DROP TABLE IF EXISTS` for every `newsroom_*` table and `DELETE` for the tenant's identity rows — written, documented, NOT run by `load_schema.py` |
| docs / root | `CLAUDE.md` (architecture, agent names, naming conventions, gotchas about the second tenant), `README.md`, `CONSTITUTION.md`, `docs/program-operating-model.md`, `docs/assessment-tenant.md` + `assessment-goal.md` (the tenancy sections name newsroom), `docs/researcher-pipeline-crd.md`, `docs/agentcore-preview-surface.md`, `scripts/validate-assessment-tenant.sh` (isolation roles reporter/editor, the `RequireTenant newsroom` check) and the assessment isolation logs for reporter/editor (archive them under `docs/assessment-journeys/isolation/archived-newsroom/`) |

## Backlog, in order (three disjoint slices run in parallel)

A. **Middleware** — delete the newsroom routes/providers/mock/seeds/tests;
   `TENANTS = ['orgiq', 'assessment']`; roles reporter/editor gone from the
   registry, the seed matrix and `CAPABILITY_ACTIONS`; identity fallback
   users and tenant rows gone; `requireTenant`'s `Tenant` type narrowed; the
   agent proxy/allow-lists no longer know `news-*`; every remaining test
   green (`npx jest`), `tsc` clean. Adjust — do not delete — the assessment
   tenant-gate tests so the outside-role matrix is the five orgiq roles.
B. **Portal** — delete `pages/newsroom`; remove the route tree, the flag,
   nav/palette/breadcrumb/roster/tenant-label entries, the `Tenant` union
   member; `tsc` clean, `node --test` green, `vite build` green; the picker
   shows two workspaces for u-operator.
C. **Agents, infra, schema, synth, docs, validators** — delete the three
   agent directories and every build/deploy reference; drop the runtimes,
   repos, roles and Cognito seed users from the CDK stacks (`npx cdk synth`
   must still synthesize every stack except the credential-bound one);
   `newsroom_schema.sql` deleted and unregistered, the drop migration
   written; synth pipeline stages and CLI subcommands removed (`python3 -m
   schema.synth --help` shows none); docs updated; the assessment validator's
   isolation matrix reduced to the five orgiq outside roles with the
   reporter/editor logs archived; `docs/newsroom-removal.md` written.
D. **Proof** — `scripts/validate-newsroom-removal.sh` exits 0;
   `scripts/validate-assessment-tenant.sh --no-time` and
   `scripts/validate-distillation.sh` still exit 0; a browser pass as
   u-operator (`docs/newsroom-removal-journey.md` + screenshot): `/select`
   shows Org and Assessment only, `/newsroom` and `/newsroom/articles`
   render not-found, the palette has no newsroom entries, and
   `GET /api/newsroom/articles` is 404 (route gone, not 403).

## Rules that do not bend

- The validator is the judge; the grep must be empty, not "mostly empty".
- No `npm install`; no commits; one owner per shared file (`App.tsx`,
  `Layout.tsx`, `portalCommands.ts`, `index.ts`, `session.ts`, `CLAUDE.md`).
- The database drop migration is written and documented, never auto-run.
