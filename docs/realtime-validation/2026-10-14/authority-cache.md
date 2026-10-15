# Gateway authority cache and inbound budget — 2026-10-14

Follow-up to `capacity-r6.md` (owed item 1, "adopt 0.120 in the BFF"). This is a
local correctness record, not a capacity acceptance: production keeps both
features off until a container-mode capacity run accepts them.

## What is on, and where

| Flag | Default | What it does |
|---|---|---|
| `REALTIME_AUTHORITY_CACHE` | on outside production, off in production | `withAuthorityCache` over `admitChannel` (`lib/realtime-gateway.ts` `gatewayVerdictCache`) |
| `REALTIME_AUTHORITY_CACHE_MAX_AGE_MS` | 5000 | backstop for a missed event (V5), not the revocation path |
| `REALTIME_INBOUND_RATE_LIMIT` | on outside production, off in production | the library's per-socket token bucket |
| `REALTIME_INBOUND_FPS` / `_BURST` | 50 / 100 | budget per connection |

Composition: `admitChannel` → verdict cache keyed by `authorityEpoch` (signed
session epoch + the seam's generations for the user, the masquerading actor and
everything) → principal revalidation on every check, hits included (V4) → a
disconnect drops the connection's verdicts (V7). `social:deck:*` and
`*:flowrun:*` bypass the cache: their answer depends on another conversation's
membership or a row no invalidation is keyed by.

## The invalidation seam

`middleware/src/lib/gateway/authority-invalidation.ts`: `invalidateForUser`,
`invalidateChannel`, `invalidateAll`, called after commit. Each bumps a
generation (so an in-flight check cannot store a stale verdict), drops matching
entries now, and publishes on the Redis router's peer events
(`orgiq:authority`). Social membership writes reach peers on the router's own
`social:membership` topic (`membershipStore` + `authorityCache` hooks).

| Write | Call |
|---|---|
| `setGrants`, `grantRole`, `revokeRole`, `bumpSessionEpoch`, `deleteIdentityClone` (identity `directoryChanged`) | user |
| Social team `addTeamMember`, `removeTeamMember`, roster replacement in `getTeam` | user |
| Social channel/DM membership (`MirroredMembershipStore.putMember` → `onCommittedWrite`) | channel (+ its `social:workgraph:conversation:` stream) |
| Huddle seats: `invalidate`, `registered`, `removed`, `restored`, `reconcile` leave, `finish` | channel |
| Access `insertRequest`, `saveTransition`, `casRequest`, `casStep` | channel `access:req:<id>` |
| Access `insertDelegation`, `endDelegation`, `updateCatalogItem` | all |
| Assessment `deleteTeam` | channel `assessment:team:<id>` |
| Cedar policy edits (`clearAuthzCache`, after Create/Update/DeletePolicy, PutSchema) | all |
| Mock world switches (`rehydrateAll`: scenario, pin, fixture reset, full reset) | all |

Not hooked, by finding: assessment team membership has no writer in the tree and
is not an input of the channel decision (only `teamExists` is); the initiative
deck budget tier is grants + Cedar (both hooked); no initiative or pipelines-run
delete path exists, and those are lobby resources (calls are not cached).

Known gaps: the Social team roster mirror is per process (a peer's mirror is
stale with or without the cache); a membership row changed by a writer outside
this BFF reaches the cache only through a peer hint or `maxAgeMs`; access
lane E's SQL (`BUMP_EPOCH_SQL`, `GRANT_ROLE_SQL`) is not executed yet, and the
coverage test fails the day it is executed outside the seam.

## Inbound budget: measured portal rates

Headless Chromium (Playwright) against `dev:mock` on :3001 and the portal on
:5183, identity clones of u-ines / u-kofi on a pipelines run's activity graph,
counting `framesent` on `/ws`:

| Activity | Frames | Mean | Peak in 1 s | Peak in 100 ms |
|---|---|---|---|---|
| Idle, 3 s | 0 | 0 | 0 | 0 |
| Drag (button held), ~27–31 Hz pointer, 23–27 s | 91–107 `cursor:update` | 3.97/s | 5 | 1 |
| Hover, same rate | 48–52 | 3.97–4.01/s | 5 | 1 |
| Synthetic pointer stream at 413 Hz, 5 s | 40 | 7.97/s | 8 | 2 |
| Page load (run graph) | 7 | — | 7 | 6 |
| Page load (`/social`, an initiative page) | 2 | — | 2 | 2 |

The client throttles cursors (`useCursor`, 250 ms) and typing (one frame per
2.5 s). The default 50/s with a burst of 100 is over 6× the sustained peak and
over 14× the load burst, so it was kept. Not measured: call signalling bursts
(ICE trickle) on a busy call.

## Evidence

- `lib/gateway/__tests__/authority-cache-contract.test.ts` (10): real sockets,
  `maxAgeMs` 60 s; for grants (non-source grant), epoch, Social membership, team
  roster, Cedar, the access read rule and assessment team deletion, the probe is
  first a cache hit, then a removal refuses the next frame and a grant admits it.
  A control shows a removal written around the seam stays admitted.
- With the seam disabled, 8 of those 10 fail, as does the huddle departure test
  in `call-chat-gateway.test.ts` (epoch bump is also caught by revalidation).
- `authority-invalidation-coverage.test.ts` (12): every write site in the
  registered surfaces sits in a function that calls the seam; the same write
  signatures elsewhere under `src/` fail; the gateway wiring is pinned.
- In-process probe: two joins and five DM sends gave 23 cache hits and 3 misses.
