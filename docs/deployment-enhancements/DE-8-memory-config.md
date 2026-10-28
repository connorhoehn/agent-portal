# DE-8 AgentCore Memory as per-tenant config

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Step 1 below is a fix that should not wait for the config work.

## Current state (read from the code, 2026-10-27)

The backlog frames this as moving strategies from code to config. The code
shows a bigger problem first: memory is not scoped per user or per tenant.

- **One memory, hard-coded.** `OrgIQ-AgentCoreMemory` creates a single
  `CfnMemory` (`infra/lib/agentcore-memory-stack.ts:51`) with 90-day event
  expiry (`:54`) and three strategies (semantic, summary, user preference)
  whose namespaces are `/orgiq/{actorId}/…` with no tenant segment
  (`:56`–`:78`). Its id is consumed by import from the runtime and middleware
  stacks (`infra/bin/app.ts:213`, `:446`), the frozen-export pattern
  `CLAUDE.md` warns about for the KB.
- **The strategies feed nothing.** The only writer and reader is the BFF:
  `CreateEvent` per turn and `ListSessions`/`ListEvents` for history
  (`middleware/src/providers/memory.ts:72`–`:120`, `:169`–`:225`). Its header says
  it does not query long-term records (`memory.ts:9`–`:10`), and no code calls
  `RetrieveMemoryRecords`. The supervisor reads `MEMORY_ID` and never uses it
  (`agents/supervisor/main.py:56`). The strategies extract records (and spend
  model tokens; billing unverified) that no one reads.
- **Every user shares one actor.** `actorId` comes from the request body or
  query (`middleware/src/routes/agents.ts:257`, `routes/sessions.ts:15`, `:73`),
  defaulting to `'portal-default'` (`memory.ts:54`–`:56`). The portal never
  sends one (`portal/src/pages/InvokePage.tsx:299`–`:302`,
  `portal/src/pages/projects/initiativeAgentRequest.ts:26`–`:30`). So every
  signed-in user's turns land in one bucket, `GET /api/sessions` lists all of
  them, and any caller can read another actor's transcript by passing
  `?actorId=`.
- **No tenant boundary.** `/api/sessions` is behind `requireTenant('orgiq')`
  (`middleware/src/index.ts:492`), but `/api/agents`, which writes the turns, is
  behind `requireSession('ViewAgents')` only (`index.ts:222`), so another
  tenant's chat writes into the same actor if its role holds `ViewAgents`
  (grants per tenant not checked).
- **Unused grant.** `MemoryAccessPolicy` (`agentcore-memory-stack.ts:87`) is
  attached to nothing; the middleware task gets its own scoped grant
  (`infra/lib/middleware-service-stack.ts:559`–`:569`).

## Change

**Step 1: scope by session, not by request (no infra change).**
`actorId = <tenant>:<sub>` derived from the session cookie in `agents.ts` and
`sessions.ts`; body and query `actorId` are ignored (accepted only for an
`admin.cedar` masquerade, mirroring `act`). `memory.ts` loses its
`'portal-default'` default and refuses to write without an actor. Old
`portal-default` events stay readable only to `admin` under a "legacy shared"
view, then expire on the 90-day clock; no migration.

**Step 2: config file.** `infra/memory-config.json`, validated at synth:

```json
{
  "default": { "eventExpiryDays": 90, "strategies": [] },
  "tenants": {
    "orgiq":      { "eventExpiryDays": 90, "strategies": ["summary", "user_preference"] },
    "assessment": { "eventExpiryDays": 365, "strategies": [] },
    "social":     { "eventExpiryDays": 30, "strategies": [] }
  }
}
```

Strategy names map to the three built-in strategy blocks the stack already
writes; namespaces gain the tenant: `/orgiq/{actorId}/…` becomes
`/<tenant>/{actorId}/…` by virtue of the actor id. Because expiry is a
property of the memory resource, not of a namespace, **per-tenant retention
means one `CfnMemory` per distinct config**. The stack creates one per tenant
entry and publishes each id to SSM (`/orgiq/memory/<tenant>/id`) instead of a
CFN export, so adding a tenant never touches a frozen import. The BFF reads
`MEMORY_ID_<TENANT>` (or the SSM parameter) and picks the memory from the
session's tenant; with no entry it does not record.

**Step 3 (only if wanted): read the strategies.** Before keeping any
strategy enabled, add the reader: `RetrieveMemoryRecords` on the
`user_preference` namespace into the supervisor's context, behind a flag. A
strategy with no reader is removed from the config, not kept "for later".

Mock floor: a registered memory fixture keyed by `<tenant>:<sub>`, so
`POST /api/__mock/reset` restores it and the isolation tests run offline.

## Decisions owed

- **Strategies with no reader.** Proposal: disable all three until step 3
  ships a reader for one; summary and semantic have no consumer in sight.
- **Retention per tenant.** Proposal above (orgiq 90, assessment 365 for
  audit trails, social 30); needs your numbers. Whether changing
  `eventExpiryDuration` or strategies replaces the resource (and drops its
  events) is unverified; if it does, retention changes become a dated
  migration.
- **Which tenants record chat at all.** Proposal: orgiq and assessment only.

## Done when

- A middleware jest test: two sessions as different users post turns, and
  each `GET /api/sessions` lists only its own; `?actorId=<other>` returns the
  caller's own list; a non-orgiq session's turn writes under its tenant's
  actor or not at all.
- `grep -n "portal-default" middleware/src` is empty outside tests.
- `cd infra && npm test` asserts one `CfnMemory` per tenant entry with the
  configured expiry and strategies, SSM parameters for each id, no
  `orgiq-memory-id` import left in `app.ts`, and no unattached memory policy.
- A config with an unknown strategy or tenant fails synth.
- `scripts/validate-mock-floor.sh` stays green with the per-actor fixture.
