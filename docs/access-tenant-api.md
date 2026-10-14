# `access` tenant — wire shapes for A0

The middleware (`routes/access.ts`, mock fixtures) and the portal
(`pages/access/*`) are built against this file so they meet. Every route mounts
under `/api/access` behind `requireTenant('access')`; gates per route as in
`docs/access-tenant-goal.md`. Timestamps are ISO strings from the mock clock.
Unknown body keys are 400 `{ error }`. Lists return `{ items, limits? }` and
never a count a client could derive.

```ts
type AccessKind = 'tenant-role' | 'initiative-membership';
type Duration = '8h' | '24h' | '7d' | '30d' | 'standing';
type RequestStatus = 'draft' | 'submitted' | 'pending' | 'approved' | 'provisioned' | 'active'
  | 'expired' | 'revoked' | 'rejected' | 'withdrawn';
type StepKind = 'manager' | 'steward' | 'access-admin';
type StepStatus = 'waiting' | 'current' | 'approved' | 'rejected' | 'info-requested' | 'skipped';

interface CatalogItem {
  id: string;                       // 'role:orgiq:sme' | 'initiative:p-auth-migration'
  kind: AccessKind;
  tenant: 'orgiq' | 'assessment' | 'social' | 'pipelines';
  role?: string;                    // tenant-role
  projectId?: string;               // initiative-membership
  title: string;                    // 'SME in Work' | 'Member of Auth migration'
  description: string;
  sensitive: boolean;               // adds the access-admin step
  defaultDuration: Duration;
  stewardRule: 'tenant-steward' | 'initiative-owner';
  heldByActor: boolean;             // computed from the actor's current grants / contributions
  sodConflicts: Array<{ policyId: string; reason: string; severity: 'warn' | 'block' }>;
}

interface Person { id: string; displayName: string; personId?: string | null }

interface RequestStep {
  step: number;                     // 1..n
  kind: StepKind;
  status: StepStatus;
  decidedBy?: Person | null;
  decidedAt?: string | null;
  comment?: string | null;
  /** Who may decide it NOW, resolved live (never stored): shown, not trusted. */
  eligible: Person[];
}

interface AccessRequest {
  id: string;                       // 'req-0001'
  requester: Person;
  beneficiary: Person;
  item: CatalogItem;                // denormalised snapshot for display (id is the join key)
  justification: string;
  duration: Duration;
  status: RequestStatus;
  steps: RequestStep[];
  submittedAt: string;
  decidedAt?: string | null;
  provisionedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  sod: { verdict: 'clear' | 'warn' | 'block'; conflicts: CatalogItem['sodConflicts']; overriddenBy?: Person | null; overrideReason?: string | null };
  /** What the signed-in actor may do with it now. */
  can: { decide: boolean; withdraw: boolean; viewAudit: boolean };
  thread: string;                   // 'access:req:<id>'
}

interface AccessPolicy {
  id: string; title: string; reason: string; severity: 'warn' | 'block';
  left: { tenant: string; role: string }; right: { tenant: string; role: string };
  updatedAt: string; updatedBy?: Person | null;
}

interface AccessEvent {
  id: string; at: string; requestId: string; actor: Person | null;   // null = system (expiry)
  kind: 'submitted' | 'step-approved' | 'step-rejected' | 'info-requested' | 'withdrawn'
    | 'approved' | 'provisioned' | 'expired' | 'revoked' | 'sod-override' | 'policy-updated';
  before?: string | null; after?: string | null; reason?: string | null;
}
```

| route | gate | response |
|---|---|---|
| `GET /summary` | ViewAccess | `{ openRequests, pendingForMe, activeElevations, policies, reviews }` — numbers counted from rows at request time |
| `GET /catalog?kind=&tenant=&q=` | ViewAccess | `{ items: CatalogItem[] }` |
| `GET /requests?scope=mine\|reports\|all&status=&q=` | ViewAccess (`all` needs DecideAccess) | `{ items: AccessRequest[] }` |
| `POST /requests` body `{ itemId, justification, duration, beneficiaryId? }` | RequestAccess | 201 `AccessRequest`; 400 on bad body (justification < 20 chars, unknown item, bad duration); 403 when `beneficiaryId` is not self and the actor lacks DecideAccess; 409 `{ error, sod }` when a `block` conflict exists and no override |
| `GET /requests/:id` | ViewAccess + read rule | `AccessRequest`; 404 outside the read rule |
| `POST /requests/:id/withdraw` | requester or beneficiary | `AccessRequest` (status `withdrawn`); 409 if terminal |
| `GET /approvals` | DecideAccess | `{ items: AccessRequest[] }` whose current step the actor may decide now |
| `POST /requests/:id/steps/:step/decide` body `{ decision: 'approve'\|'reject'\|'info', comment }` | DecideAccess + row rules | `AccessRequest`; 403 `{ error: 'You cannot decide your own request' }` when actor is requester/beneficiary; 403 when not eligible; 409 when the step is already decided; the last approval provisions (A1, `lib/access-provision.ts`): status `active` with `provisionedAt`/`expiresAt`, or `approved` if the grant write failed |
| `GET /policies` | ViewAccess | `{ items: AccessPolicy[] }` |
| `PUT /policies/:id` body `{ severity?, reason? }` | ManageAccessPolicy | `AccessPolicy` |
| `GET /audit?requestId=&q=` | ViewAccess (own) / DecideAccess (all) | `{ items: AccessEvent[] }` |
| `GET /reviews` | ViewAccess | `{ items: AccessReview[] }` (lane A2, below) |

Discussion thread per request: `access:req:<id>` (`AccessRequest.thread`). The
gateway admits it (A1) to whoever passes `GET /requests/:id`'s read rule now,
standing in `access` with `ViewAccess`; posting needs the same
(`middleware/src/lib/access/thread.ts`, family `access:req` in
`lib/tenant-channels.ts`, reader cursors on).

Provisioning (A1): a `tenant-role` merges the role into the beneficiary's
grants (`setGrants`); an `initiative-membership` inserts a
`project_contributions` row (role `contributor`). Neither bumps the
beneficiary's `session_epoch`: the grant reaches their open cookie through the
≤120 s grants refresh. Revocation and expiry (`lib/access-expiry.ts`) remove
it, bump the epoch (retiring every cookie they hold) and record
`revoked`/`expired`; the bell warns the requester and beneficiary 24 h before.

## Lane A2 — separation of duties at provisioning, manual revoke, reviews, configuration

Additions to the A0/A1 shapes (all additive):

```ts
type RequestKind = 'grant' | 'revocation';
// AccessEvent.kind gains 'sod-blocked'; AccessEvent.requestId is null for a
// policy change ('policy-updated'), which names policyId instead.
interface AccessEvent { /* … */ requestId: string | null; policyId: string | null }

interface RequestStep {
  /* … */
  /** Why `eligible` is an escalation rather than the step's own candidates, else null. */
  escalated: string | null;
}

interface AccessRequest {
  /* … */
  kind: RequestKind;                 // 'revocation': created pre-approved by an access review
  reviewId: string | null;           // the campaign a revocation came from
  can: { decide; withdraw; viewAudit;
         revoke: boolean;            // ProvisionAccess, kind 'grant', status 'active'
         overrideSod: boolean };     // ManageAccessPolicy, live verdict 'block', not overridden, not a party
}

interface AccessReview {
  id: string;                        // 'rev-0001'
  tenant: 'orgiq' | 'assessment' | 'social' | 'pipelines';
  title: string;
  status: 'open' | 'closed';
  owner: Person | null;              // access_reviews.opened_by — decides its items with any access-admin
  openedAt: string; closedAt: string | null;
  progress: { total: number; decided: number; kept: number; revoked: number };  // over the items the viewer may see
  can: { decide: boolean };
}

interface AccessReviewItem {
  id: string;                        // 'ri-0001'
  reviewId: string;
  user: Person; tenant: AccessReview['tenant']; role: string;   // one standing (user, role) grant
  decision: 'keep' | 'revoke' | null;
  decidedBy: Person | null; decidedAt: string | null; comment: string | null;
  revocationRequestId: string | null;  // the revocation a 'revoke' created
  can: { decide: boolean };          // owner or access-admin, open campaign, undecided, never one's own grant
}

interface AccessConfiguration {
  durations: { offered: Duration[]; standingReasonMin: number };          // fixed (A6)
  stewards: Array<{ scope: 'tenant-role' | 'initiative-membership' | 'sensitive'; tenant: string | null; rule: string; role: string | null }>;  // fixed (A4)
  items: Array<{ id; title; kind; tenant; defaultDuration: Duration; stewardRule; sensitive: boolean }>;
}
```

| route | gate | response |
|---|---|---|
| `POST /requests/:id/sod-override` body `{ reason }` | ManageAccessPolicy | `AccessRequest`; 400 when `reason` < 20 chars or an unknown key; 403 on a request the actor submitted or benefits from; 404 outside the read rule; 409 when no blocking conflict applies now, it is already overridden, the request is not open/approved, or it is a revocation. Records `sodOverriddenBy`/`sodOverrideReason`, event `sod-override`; an `approved` request is provisioned at once |
| `POST /requests/:id/revoke` body `{ reason }` | ProvisionAccess | `AccessRequest` (status `revoked`); 400 without a reason; 409 unless an active grant. Through `revokeAccess(request, reason, actor)`: role removed, the beneficiary's `session_epoch` bumped, event `revoked` |
| `GET /reviews` | ViewAccess | `{ items: AccessReview[] }`, newest first |
| `POST /reviews` body `{ tenant, title }` | ManageAccessPolicy | 201 `{ review, items }` — one item per (user, role) the directory holds in `tenant` now (`admin` excluded); 400 bad tenant / title (3–200); 409 when nobody holds a grant there |
| `GET /reviews/:id` | ViewAccess | `{ review, items: AccessReviewItem[] }` — every item with DecideAccess, otherwise only the viewer's own; 404 unknown |
| `POST /reviews/:id/items/:itemId/decide` body `{ decision: 'keep' \| 'revoke', comment? }` | DecideAccess + owner or access-admin | `{ review, item }`; 400 bad decision, or `revoke` without a comment; 403 not the owner/an access admin, or one's own grant; 409 decided already or campaign closed. `revoke` inserts a `kind: 'revocation'` request (requester = reviewer, one approved `access-admin` step, events `submitted`, `approved`), revokes it through `revokeAccess` with the reviewer as actor (status `active` → `revoked`), and revokes the active grant request that provisioned the same grant, if any; the campaign closes when every item is decided |
| `GET /configuration` | ViewAccess | `AccessConfiguration` |
| `PUT /configuration` body `{ items: [{ id, defaultDuration?, sensitive? }] }` | ManageAccessPolicy | `AccessConfiguration`; 400 on unknown keys, `durations`/`stewards` (fixed), an unknown item, a bad value, or a descriptive field changed — and then nothing is written |

Separation of duties at provisioning (A7): `provisionAccess` re-evaluates the
policies against the beneficiary's **current** grants before writing. A `block`
without an override leaves the request `approved`, stores `sodVerdict: 'block'`,
appends one `sod-blocked` event (system actor) and rings the requester, the
beneficiary and the access admins once (`access-sod-blocked`); the submit
pre-check (409) is unchanged.

Eligibility (decided during A0, applied on every read): a step whose own
candidates leave nobody — none on record, only a party, or nobody with a
deciding role in Access — escalates to the access admins, and, when every
access admin is a party, to the `admin` holders in `access`; `escalated` says
why.

Audit: `GET /audit` follows the request read rule for everyone below
access-admin (who, with `admin`, reads every event); `policy-updated` events
(`PUT /policies/:id`: severity before → after, the reason) are read by
DecideAccess holders.

The agent loop's `GET /api/conversations/agent/waiting?channel=access:req:<id>`
answers `{ runs: [] }` to a reader of the request (request threads carry no
agent) and 403 to anyone else.

## Request page — preview and beneficiaries (2026-10-13)

`/access/requests/new` is one page with a live summary beside the form; two
reads feed it. Both sit on `accessRouter` behind `requireTenant('access')`.

| route | gate | response |
|---|---|---|
| `POST /requests/preview` body `{ itemId, beneficiaryId?, duration? }` | RequestAccess | 200 `AccessRequestPreview` (below), written nowhere. 400 on an unknown key, no/unknown `itemId`, a bad `duration`, an unknown beneficiary or a non-string `beneficiaryId`; 403 when the actor may not file for `beneficiaryId` (the submit's own on-behalf rule). Already held, a duplicate open request and an SoD block are **200** with `refusal` set, so the page shows them before anyone submits |
| `GET /beneficiaries` | RequestAccess | `{ items: Person[] }` the actor may file for: self first; an approver (DecideAccess) adds their direct reports through `people.manager_id`; an access admin (DecideAccess + ProvisionAccess) adds everyone the directory holds with any grant, sorted by name |

The preview runs `assessSubmission` (`routes/access.ts`), the same checks in
the same order as `POST /requests`, so the page and the submit cannot
disagree; the chain is `planChain` with each step's deciders resolved live
(`eligibility`) as if the actor filed it now.

```ts
interface AccessRequestPreview {          // middleware/src/lib/access/types.ts
  item: CatalogItem;                      // heldByActor / sodConflicts are the ACTOR's (the catalog view)
  beneficiary: Person;
  steps: Array<{ step: number; kind: StepKind; eligible: Person[]; escalated: string | null }>;
  sod: { verdict: 'clear' | 'warn' | 'block'; conflicts: SodConflict[] };   // the BENEFICIARY's current grants
  duration: Duration;                     // the body's, else the item's default
  expiresIfProvisionedNow: string | null; // expiry counts from provisioning; null for standing
  refusal: null | { status: 400 | 403 | 409; error: string; requestId?: string };  // requestId: the open duplicate
}
```

## Quick request — `/api/access-requests` (decided 2026-10-13)

The in-tenant door to the same workflow: a reader who meets a locked figure
asks for the access that opens it **from where they are**, without switching to
Access. Mounted in `index.ts` as `app.use('/api/access-requests',
accessQuickRouter)` (`middleware/src/routes/access-requests-quick.ts`) behind a
**session floor only** — not `requireTenant('access')`, not `RequestAccess`.
It files through `routes/access.ts` `fileRequest`, the one submit path
`POST /api/access/requests` also uses, so the chain, the SoD pre-check, the
duplicate / already-held refusals, the rows, the events and the approvers' bell
items are identical. It never decides, withdraws or provisions.

| route | response |
|---|---|
| `POST /quick` body `{ itemId, justification, duration }` | 201 `AccessRequest` — the caller is requester **and** beneficiary. 400 on an unknown key (`beneficiaryId` included), an unknown item, `justification` < 20 characters, a bad `duration`; 403 when the item's `tenant` is not the caller's CURRENT tenant, or the session has no directory account (the cookie-less demo persona); 409 `{ error, requestId }` when an open request for the item already exists; 409 when the caller holds it; 409 `{ error, sod }` on a blocking SoD conflict |
| `GET /mine?itemId=` | `{ items: AccessRequest[] }` — the caller's own requests (requester or beneficiary) for that item, newest first, any status. 400 without `itemId` or with another parameter; 400 for an unknown item; 403 for another tenant's item |

The one item the portal asks for today is budget visibility in Work:

```ts
// CatalogItem additions
type AccessKind = 'tenant-role' | 'initiative-membership' | 'capability';
type StewardRule = 'tenant-steward' | 'initiative-owner' | 'budget-owner';

{ id: 'capability:orgiq:budgets-read', kind: 'capability', tenant: 'orgiq',
  role: 'budgets-reader',            // the grant entry provisioned (not a role)
  title: 'Budget visibility in Work', sensitive: false, defaultDuration: '30d',
  stewardRule: 'budget-owner' }      // manager, then the orgiq org-leaders
```

A `capability` item provisions like a `tenant-role` (the entry merges into the
beneficiary's grants through `setGrants`; revocation and expiry remove it and
bump the epoch) and carries no SoD. `GET /configuration`'s `stewards` gains
`{ scope: 'capability', tenant: 'orgiq', rule: 'budget-owner', role: 'org-leader' }`.

Where the lock comes from — `GET /api/graph/projects` and
`GET /api/graph/projects/:id` below the budgets read tier
(`middleware/src/lib/budget-read-tier.ts`) omit `agentSpendUsd` and
`allocatedUsd` and add, per row:

```ts
budgetAccess: { visible: false; reason: string; requestItemId: 'capability:orgiq:budgets-read' }
```

A tier holder's payload is unchanged (no `budgetAccess` key). A locked budget
answer from the local assistant carries the same item as
`action: { kind: 'request-access', itemId, label, href }` (`docs/local-answers.md`).
