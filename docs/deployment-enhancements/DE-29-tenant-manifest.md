# DE-29 Tenant manifest: one registration record per tenant

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on nothing. DE-17 (parameterised environments) can later read which
tenants an environment enables from the same file.

## Current state (read from the code, 2026-10-27)

The backlog line is right that the tenant list is repeated, and wrong in its
goal: "a tenant is added without code changes" cannot hold here. Tenants are
separate products (CLAUDE.md; each has its own routers, pages, judge and
journeys), so a new tenant is always new code. What can be removed is the
*registration* repeated by hand in a dozen places, and the drift that causes.

**Already derived from one source.** Roles are discovered from the Cedar files
at boot: `middleware/src/lib/role-registry.ts` and `lib/policy-seeds.ts:36-37`
walk `middleware/seeds/roles/{tenant}/{role}.cedar` (cross-tenant `admin.cedar`
at the top level), and the mock-floor parity invariant checks every seeded
grant against those files (`mock/core/parity/invariants.ts:688-722`). Cedar
policies are seeded by the BFF, not CDK (`infra/lib/authorization-stack.ts:16-19`).

**Hand-maintained copies of the tenant list or its subsets:**

| Where | What | Line |
|---|---|---|
| `middleware/src/lib/session.ts` | `TENANTS`, `ROLES_BY_TENANT`, the `Role` union, `DEMO_EXCLUDED_TENANTS` | `:24`, `:30-38`, `:43`, `:96` |
| `middleware/src/index.ts` | router mounts behind `requireTenant(...)` | `:300-351` |
| `middleware/src/lib/authz.ts` | per-tenant blocks of `CAPABILITY_ACTIONS` | `:34-97` |
| `middleware/src/lib/call-access.ts` | `HUDDLE_CHAT_TENANTS` | `:16` |
| `middleware/src/lib/tenant-channels.ts` | channel families, `TENANT_PARTITIONS` | `:191`, `:197` |
| `middleware/src/lib/search-index/tenants.ts` | `INDEXED_TENANTS` | `:12` |
| `middleware/src/lib/access/types.ts` | `ACCESS_TENANTS` (tenants the access product governs) | `:4` |
| `middleware/src/lib/gateway/authority.ts` | an inline three-tenant list | `:170` |
| `schema/identity_schema.sql` | `INSERT INTO tenants` | `:52-57` |
| `portal/src/lib/auth.tsx` | `Tenant` union | `:11` |
| `portal/src/lib/features.ts` | `tenantEnabled` per-tenant flags | `:33-39` |
| `portal/src/lib/tenantHome.ts` | `TENANT_HOME` | `:24-36` |
| `portal/src/App.tsx` | route trees | `:283`, `:334`, `:371`, `:428` |
| `portal/src/components/shell/discussionUnreadModel.ts` | `DISCUSSION_TENANTS` | `:26` |
| `portal/src/pages/observability/AuthzLogPage.tsx` | `TENANT_FILTERS` | `:46` |
| `infra/lib/authentication-stack.ts` | Cognito seed users per tenant cast | `:120-146` |
| `portal/e2e/route-inventory.ts` | per-tenant audit sign-ins | `:34-81` |

Proof the drift is real: `AuthzLogPage.tsx:46` lists four tenants and has no
`access`, so the authz log cannot be filtered to the fifth tenant.

Two corrections to CLAUDE.md found on the way: the guardrails stack builds
three guardrails, for orgiq's `member`, `org-leader` and `hr-admin` only
(`infra/lib/guardrails-stack.ts:11`, `:83`), not "one per role"; and the CDK
holds no tenant list, only per-tenant resources (assessment agents in
`agentcore-runtime-stack.ts:95-96`, Social stacks, the assessment-only
document adapter at `document-workspace.ts:45`).

Validators grep CLAUDE.md for each tenant's roles and docs-map row
(`scripts/validate-access-tenant.sh:93-97`,
`validate-pipelines-tenant.sh:247-251`, `validate-social-tenant.sh:326-327`).
CLAUDE.md therefore stays the human copy and must keep its current wording.

## Change

1. **`tenants/manifest.json`** at the repo root, one entry per tenant:
   `id`, `displayName`, `roles` (ordered), `apiPrefix` (`""` for orgiq),
   `portalRoot`, `home`, `featureFlag` (the `VITE_*` name or null),
   `demoGrant`, and capability booleans `huddleChat`, `discussions`,
   `searchIndexed`, `governedByAccess`, `channelPartition`. Capabilities are
   facts about the product, not shared chrome; nothing in the manifest creates
   shared nav or journeys.
2. **Generated, checked-in TypeScript.** `scripts/gen-tenants.mjs` writes
   `middleware/src/lib/tenants.generated.ts` and
   `portal/src/lib/tenants.generated.ts` (`as const` arrays and unions, so
   types stay literal) and the `INSERT INTO tenants` block in
   `identity_schema.sql` between marker comments. Every list in the table
   above imports from the generated file or derives a subset by capability
   (`TENANTS.filter(t => MANIFEST[t].huddleChat)`); `AuthzLogPage` gets
   `access` for free.
3. **What stays code.** Router mounts, pages, route trees, Cedar policies and
   the Cognito cast stay hand-written per product. A new check
   (`scripts/check-tenant-manifest.mjs`) asserts they agree with the manifest:
   a `seeds/roles/<id>/` directory per tenant whose files equal `roles`; an
   `app.use('<apiPrefix>', requireTenant('<id>')…)` mount for each non-orgiq
   tenant; a `path="<portalRoot>"` tree in `App.tsx`; `home` under
   `portalRoot`; CLAUDE.md naming each tenant's roles in order (the same
   pattern the validators already grep). Generated files must match a fresh
   run.
4. **CDK reads it only where it already loops.** The Cognito cast keeps its
   per-tenant users; the check above reports a tenant with no cast. Runtimes
   and stacks are not driven by the manifest: an agent or a stack is a
   product decision, and generating them would hide cost.

## Decisions owed

- **Generated code or runtime JSON import?** Proposal: generated, checked-in
  TS, because `Tenant` and `Role` must stay literal unions for `tsc`, and the
  portal build should not read a file outside `portal/`.
- **Do role labels and summaries move in?** `role-registry.ts`'s
  `PRESENTATION` map is a second hand list. Proposal: yes, as `roles[].label`
  and `roles[].summary`, keeping the Cedar files the authority for actions.

## Done when

- `node scripts/gen-tenants.mjs --check` exits 0, and exits 1 after editing a
  generated file by hand.
- `node scripts/check-tenant-manifest.mjs` exits 0 on `main`, and exits 1 for
  each fixture: a manifest role missing from `seeds/roles/`, a tenant with no
  `requireTenant` mount, CLAUDE.md missing a role.
- `grep -rnE "\['orgiq', *'assessment'" middleware/src portal/src --include='*.ts' --include='*.tsx' | grep -v __tests__ | grep -v generated`
  finds nothing.
- `cd middleware && npm test && npm run typecheck`, `cd portal && npm run typecheck`,
  `scripts/validate-mock-floor.sh`, and the tenant judges (`validate-assessment-tenant.sh`, `-social-tenant`, `-pipelines-tenant`, `-access-tenant`, `validate-work-journeys.sh`) stay green.
