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
| `GET /reviews` | ViewAccess | `{ items: [] }` until A2 |

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
