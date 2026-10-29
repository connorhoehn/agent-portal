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

Provisioning (A1): a `tenant-role` writes the one role into the beneficiary's
grants (`grantRole`, a single row); an `initiative-membership` inserts a
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
beneficiary's grants through `grantRole`; revocation and expiry remove it and
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

## Sprint envelopes — "Request budget" from the dispatch drawer (2026-10-28)

An SME the grant-scoped dispatch gate refuses (`POST /api/bots/dispatch-work`
403 "you hold no active sprint grant", `lib/bot-runner.ts`) asks for the
envelope from where they are. It is an ORDINARY access request for a new item
kind, filed through `fileRequest` like the quick request above; the last
approval provisions a `budget_grants` row through the same path
`POST /api/grants` takes (`lib/grant-envelope.ts`), so an envelope granted by
approval and one granted by hand are the same row to every reader.

```ts
type AccessKind = 'tenant-role' | 'initiative-membership' | 'capability' | 'sprint-envelope';
type StewardRule = 'tenant-steward' | 'initiative-owner' | 'budget-owner' | 'budget-holder';

// One DERIVED catalog item per initiative — never seeded, never edited through
// PUT /configuration (400), listed by GET /catalog like any other item:
{ id: 'envelope:<projectId>', kind: 'sprint-envelope', tenant: 'orgiq', projectId,
  title: 'Sprint envelope on <initiative name>', sensitive: false,
  defaultDuration: 'standing',          // the grant lives until revoked, like one granted by hand
  stewardRule: 'budget-holder' }
// heldByActor: the actor's person holds an ACTIVE budget grant on the initiative
// (its sprint `active`, or sprint-less) — the same rule the dispatch gate reads.

interface EnvelopeForecast { workItemId: string | null; model: string | null; costUsdP25: number | null; costUsdP75: number | null }

interface AccessRequest {
  /* … */
  requestedUsd: number | null;          // sprint-envelope only: the dollars asked for
  forecast: EnvelopeForecast | null;    // sprint-envelope only: what the requester was looking at
}
```

| route | gate | response |
|---|---|---|
| `POST /api/access-requests/envelope` body `{ initiativeId, justification, requestedUsd, forecast?, duration? }` | session floor (the quick router: caller stands in `orgiq`, is requester **and** beneficiary, must have a directory account with a linked person) | 201 `AccessRequest` (`item.kind: 'sprint-envelope'`, `requestedUsd`, `forecast`). 400: unknown key, no/unknown `initiativeId`, `justification` < 20 chars, `requestedUsd` missing / not a finite number > 0, a malformed `forecast` (keys other than the four, wrong types), a `forecast.workItemId` that does not exist or is on another initiative, a beneficiary with no linked person. 403: not standing in `orgiq`, or no directory account. 409 `{ error, requestId }`: an open envelope request on this initiative already. 409 `{ error }` "already holds": an active grant on the initiative now |
| `GET /api/access-requests/mine?itemId=envelope:<projectId>` | session floor | `{ items: AccessRequest[] }` — the caller's envelope requests on that initiative, newest first (the status read) |
| `POST /api/access/requests` | RequestAccess | now also accepts `requestedUsd` and `forecast`; a `sprint-envelope` item requires `requestedUsd`, any other item refuses both (400) |

Chain: the manager step when the requester's person has `people.manager_id`,
then one **steward** step under the new rule `budget-holder` — the app user who
last set the initiative's allocation (`initiative_budgets.updated_by`) when
they hold a deciding role in Access, **otherwise the orgiq `org-leader`
holders** (the `budget-owner` rule). The A0 escalation still applies when that
leaves nobody. Conservative reading of "the budget holder, else an org-leader":
the person who allocated the money decides alone when they can; the program's
allocators decide when they cannot. In the mock the allocations were set by the
release manager (Sienna, no Access grant), so the step falls to Vera and Rachel.

Provisioning (`lib/access-provision.ts`): ONE `budget_grants` row —
`org_project_id` = the initiative, `sprint_id` = the initiative's active sprint
when one exists (newest first) else NULL (a standing grant),
`grantee_person_id` = the beneficiary's person, `allocated_usd` =
`requestedUsd`, `granted_by` = the final approver (the last approved step's
decider), `note` = the request id. The grantee's bell (`budget-grant`) and the
work graph's live hint fire as they do for `POST /api/grants`. Revocation in
Access (`POST /requests/:id/revoke`, expiry) deletes that row, found by its
note; the request's `can.revoke` and the ordinary refusals are unchanged.
`GET /configuration.stewards` gains `{ scope: 'sprint-envelope', tenant: 'orgiq',
rule: 'budget-holder', role: 'org-leader' }`; derived items are not in `items`.

Cluster: `access_catalog_items.kind` / `steward_rule` CHECKs widened,
`access_requests.requested_usd NUMERIC` and `forecast JSONB` added
(`schema/access_schema.sql`, additive); `LIST_CATALOG_SQL` derives the envelope
rows from `projects` and `INSERT_REQUEST_SQL` binds the two columns
(`lib/access/sql.ts`). The access store itself is still mock-only until lane E
applies the schema; the grant row it writes goes through `providers/grants.ts`,
whose Aurora path is real SQL.

### Saved-for-later job drafts — `/api/bots/work-items/:id/job-draft` (2026-10-28)

The drawer's other branch. Not an access route: it lives beside the estimate
on `botsRouter` (`/api/bots`, `requireTenant('orgiq')`), gated `DispatchAgentRun`
then the item's initiative scope (`requireInitiativeScope`: owner, contributor
or an org-wide role; 403 `{ error, code: 'NOT_ON_INITIATIVE', initiativeId, role }`)
on the read AND the writes. One draft per work item; a dispatch of the item
(`POST /api/bots/dispatch-work` 202) clears it. Table
`work_item_job_drafts` (`schema/work_item_job_drafts_schema.sql`), fixture
`mock/work-item-job-drafts.ts` (seed empty, reset-safe).

```ts
interface JobDraft {
  workItemId: string; model: string; budgetPerRunUsd: number | null; instruction: string | null;
  agentProjectId: string | null;       // codebase UUID
  savedBy: string; savedByName: string | null; savedAt: string; updatedAt: string;
}
```

| route | response |
|---|---|
| `GET /api/bots/work-items/:id/job-draft` | `{ draft: JobDraft \| null }`; 404 `{ error }` unknown item; 403 outside the initiative |
| `PUT /api/bots/work-items/:id/job-draft` body `{ model, budgetPerRunUsd?, instruction?, agentProjectId? }` | `{ draft }` (upsert; a second save replaces the setup and `savedBy`, keeps `savedAt`). 400: unknown key, no `model`, `budgetPerRunUsd` not a number >= 0, `instruction` not a string / over 8000 chars, `agentProjectId` not a UUID; 401 no session; 404; 403 |
| `DELETE /api/bots/work-items/:id/job-draft` | 204; 404 `{ error }` when the item has no draft (or does not exist); 403 |

## Escalation timers and delegation (lane A3, 2026-10-14)

All additive. `RequestStep` gains the escalation clock and the delegate's provenance;
`eligible` entries may name whom a delegate decides for.

```ts
interface EligiblePerson extends Person { onBehalfOf?: Person | null }   // set only for a delegate in force

interface RequestStep {
  /* … */
  eligible: EligiblePerson[];
  currentSince: string | null;     // when it became the step awaiting a decision (the clock)
  escalationLevel: 0 | 1 | 2;      // 1: + the access admins; 2: + the admin holders in `access`
  escalatedAt: string | null;
  escalatesAt: string | null;      // next escalation if still undecided (current steps of open grant requests)
  decidedOnBehalfOf: Person | null; // the delegator, when a delegate decided it
}

// AccessEvent.kind gains 'escalated' | 'delegated' | 'delegation-ended';
// AccessEvent gains delegationId (a delegation's events carry no request).

interface AccessDelegation {
  id: string;                      // 'dlg-0001'
  delegator: Person; delegate: Person;
  startsAt: string; endsAt: string; reason: string; createdAt: string;
  endedAt: string | null; endedBy: Person | null;
  state: 'scheduled' | 'active' | 'ended';   // the window against the clock, minus an early end
  can: { end: boolean };          // DecideAccess, not ended, delegator or access admin / admin
}

// GET /configuration gains (read-only; PUT refuses both keys):
//   escalation: { stepSlaHours: number; tiers: ['access-admins', 'platform-admins'] }
//   delegation: { maxDays: 30 }
```

| route | gate | response |
|---|---|---|
| `GET /delegations` | ViewAccess | `{ items: AccessDelegation[] }` — the ones the viewer delegated or received; access admins and `admin` read all; newest window first |
| `GET /delegates` | DecideAccess | `{ items: Person[] }` — every directory user holding `approver` or `access-admin` in `access`, except the viewer (the delegation form's PersonPicker) |
| `POST /delegations` body `{ delegateId, endsAt, startsAt?, reason }` | DecideAccess | 201 `AccessDelegation`; `startsAt` defaults to now. 400: unknown key, a non-string, no delegate / end, a malformed or inverted window, a window already over or longer than 30 days, a reason under 10 characters, an unknown delegate. 403: oneself. 409: a delegate with no deciding role; an overlapping delegation of one's own that has not ended; a delegate delegating during the window (no chains); a delegate who submitted or benefits from an open request waiting on the delegator now. Event `delegated`; bell to the delegate |
| `POST /delegations/:id/end` body `{ reason? }` | DecideAccess | `AccessDelegation` (state `ended`); 404 outside the read rule; 403 for the delegate; 409 once ended. Event `delegation-ended`; bell to the other party |

Escalation (`lib/access-escalation.ts`): every `ACCESS_ESCALATION_SWEEP_MS`
(60 s) a step `current` for longer than `ACCESS_ESCALATION_SLA_MS` (48 h)
since `currentSince` or `escalatedAt` moves to the next level that reaches
somebody new — single-flight across replicas under the fleet lock
`access-escalation-sweep`, one claim per (step, level), an `escalated` event
("Step 1 (manager) waited 2 days without a decision: escalated to the access
admins. Now also: …") and an `access-escalated` bell item to the people it newly
reaches. Info-requested steps wait on the requester and never escalate.

Delegation in the resolver (`lib/access/chain.ts`): a delegate in force is
added to a step's `eligible` (with `onBehalfOf`) when their delegator is
eligible there in their own right, the delegate holds a deciding role, is not
a party, and — for an `access-admin` step — holds access-admin. A delegate's
decision stores `delegated_from` on the step and appends "decided on behalf of
<delegator>" to the event's reason. The approvals inbox, the record's `can`,
the read rule and the bell all read the same resolver.

The request form's "Who" (`/access/requests/new`) and the delegation form
(`/access/settings`) choose people with the library's `PersonPicker`
(ui-components 2.452.0). `GET /beneficiaries` for an access admin now lists
every person in the directory, granted or not.

Cluster statements for all of the above: `middleware/src/lib/access/sql.ts`,
proven on native PostgreSQL 16 (`docs/access-tenant-goal.md` §E).
