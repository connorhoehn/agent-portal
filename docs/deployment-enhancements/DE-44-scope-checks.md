# DE-44 Scope checks on every entry point

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
The `/internal/devbox/sessions` fix (commit 1eeffdc8) is done; this is the audit
of every other entry point. Overlaps DE-42 (Cedar attributes) and DE-43
(separation of duties); unblocks DE-30's attribution claim.

## Current state (read from the code, 2026-10-27)

Cedar answers "may this role ever do X"; the route has to answer "here".
`lib/initiative-scope.ts` holds the one rule (owner or contributor, org-wide
roles `org-leader`/`hr-admin`/`admin` bypass, lookup failure denies), and
`grantScopedDispatchVerdict` (`lib/bot-runner.ts:769`) holds the spend rule
(an `sme` needs an active sprint grant). Only some routes ask either.

Role facts that set severity (`middleware/seeds/roles/orgiq/*.cedar`): `sme`
holds `DispatchAgentRun`, `ManageBots`, `ManageDevbox`, `ManageSprints`;
`program-owner` holds `DispatchAgentRun`, `ManageBots`, `ManageBudgets`,
`ManageSprints` and is **not** in `ORG_WIDE_INITIATIVE_ROLES`, so it is scoped
on sprints but unscoped wherever no check runs. `ManageEnvironments` is held
only by org-wide roles, so `/api/environments` is out of scope.

Severity: **high** = spends money, runs code, delivers code or discloses a
credential against an initiative the caller is not on; **medium** = changes
another initiative's governed state or reads its box; **low** = annotation.

### Checks present

| Route | Id accepted | Check |
|-------|-------------|-------|
| `POST /api/bots/dispatch-work` | `workItemId` (body) | grant verdict, `routes/bots.ts:245` |
| `POST /api/work/findings/:id/promote` | finding → initiative | grant verdict, `routes/work.ts:393` (a finding with no initiative is unscoped) |
| `POST /api/local-compute/nodes/:nodeId/work` | node, `workItemId` | node ownership `routes/local-compute.ts:1200`; grant verdict `:1240` (the `botId` branch inherits the bot gap below) |
| `POST /api/sprints`, `PATCH/DELETE /api/sprints/:id/items…` | `initiativeId`, sprint | steward, `routes/sprints.ts:290`, `:328`, `:352` |
| `POST /api/devbox/boxes` | `projectId` | steward, `routes/devbox.ts:450` |
| `PATCH/DELETE /api/devbox/boxes/:boxId`, tail | box | `canSee`, `routes/devbox.ts:474`, `:486`, `:547` |
| `/api/devbox/:sessionId/task`, `/command`, `/shell-url`, `DELETE` | session | `requireBoxAccess`, `routes/devbox.ts:645`, `:666`, `:842`, `:913` |
| `POST /internal/devbox/sessions` | `projectId` | `userStewardsInitiative`, `routes/internal-devbox.ts:176` |
| `/internal/work-graph/compute-capabilities/open`, `/authorize`, `/use`, `/revalidate` | resource, person | source owner check, `work-graph/compute-capability-sessions.ts:243`, `:222`, `:285`, `:190` |
| Runbook review (`accept`/`reject`/`merge`/`retire`) | runbook → initiative | `lib/runbook-review.ts:53`, `:63` |
| Runbook box callbacks (`/proposals` from a box, `/:id/applications`) | `run_ref` | run token, `routes/runbooks.ts:400`, `:778` |

### Checks missing

| # | Route | Id accepted | Missing | Sev |
|---|-------|-------------|---------|-----|
| 1 | `POST /api/bots` (`routes/bots.ts:608`) | `orgProjectId`, `agentProjectId` | steward on the target initiative | high |
| 2 | `PATCH /api/bots/:id` (`bots.ts:655`) | bot; new `orgProjectId`/`agentProjectId` | steward on old and new target; can also clear `enforceAllocation` | high |
| 3 | `POST /api/bots/:id/run` (`bots.ts:715`) | bot | grant verdict, envelope and allocation brakes (only the per-run cap runs) | high |
| 4 | `DELETE /api/bots/:id`, `/:id/pause`, `/:id/resume` (`bots.ts:705`, `:762`, `:773`) | bot | steward on the bot's initiative; resume re-arms a cron that spends | medium |
| 5 | `POST /api/bots/work-items/:id/estimate`, `/review-estimate` (`bots.ts:448`, `:482`) | work item | steward | low |
| 6 | `POST /api/work/jobs` (`routes/work.ts:233`) | `workItemId`/`suggestionId`, `findingId` | grant verdict; `findingId` marks a finding promoted, bypassing the promote route's check at `:393` | high |
| 7 | `POST /api/work/jobs/:id/requeue` (`work.ts:291`) | job | grant verdict on the job's initiative (requeue spends again) | medium |
| 8 | `POST /api/work/jobs/:id/review`, `DELETE /api/work/jobs/:id` (`work.ts:275`, `:304`) | job | steward | medium |
| 9 | `POST /api/work/findings/:id/dismiss` (`work.ts:460`) | finding | steward when the finding has an initiative | low |
| 10 | `POST /api/agent-projects` (`routes/agent-projects.ts:44`) | `orgProjectId` | steward; repo-target bots inherit this initiative (`resolveBotInitiativeId`, `lib/bot-runner.ts:878`), so this redirects spend attribution | high |
| 11 | `DELETE /api/agent-projects/:id` (`agent-projects.ts:63`) | codebase | steward | medium |
| 12 | `POST /api/agent-projects/:id/clone-command` (`agent-projects.ts:84`) | codebase, `sessionId` | steward and box access; returns the token-bearing clone command (DE-45) for any codebase | high |
| 13 | `POST /api/agent-projects/:id/cloned` (`agent-projects.ts:102`) | codebase, `sessionId` | box access; repoints a codebase at someone else's box | medium |
| 14 | `POST /api/agent-projects/:id/runs` (`agent-projects.ts:113`) | codebase, `sessionId` | steward, grant verdict, box access; `dispatchGovernedRun` registers an unknown session (`lib/sdlc-pipeline.ts:75`), bypassing the refusal in `requireBoxAccess` | high |
| 15 | `POST /api/agent-projects/runs/:runId/finish` (`agent-projects.ts:136`) | run | steward; any `ManageDevbox` holder can set any run's outcome | medium |
| 16 | `POST /api/sdlc/changes/:id/decide` (`routes/sdlc.ts:89`) | change → codebase → initiative | steward (self-approval is DE-43) | high |
| 17 | `POST /api/sdlc/changes/:id/address` (`sdlc.ts:135`) | change | steward and grant verdict (dispatches a run) | high |
| 18 | `POST /api/sdlc/changes/:id/deliver` (`sdlc.ts:169`) | change | steward; pushes to GitHub with the connection token | high |
| 19 | `POST /api/sdlc/changes/:id/rereview` (`sdlc.ts:109`) | change | steward (spends a review call, flips status) | medium |
| 20 | `PUT/DELETE /api/budgets/:orgProjectId` (`routes/budgets.ts:51`, `:71`) | initiative | scope for `program-owner` (decision below) | medium |
| 21 | `POST/PATCH/DELETE /api/grants` (`routes/grants.ts:58`, `:100`, `:121`) | initiative, grant | same `program-owner` question | medium |
| 22 | `PATCH /api/graph/work-items/:id` with `sprintId` (`routes/work-items.ts:413`); `POST /api/graph/work-items` with `projectId`+`sprintId` (`:328`) | work item, sprint | steward, and the same-initiative check `routes/sprints.ts:331` runs; this path bypasses both | medium |
| 23 | Other work-item writes: criteria, comments, decisions, discussion (`work-items.ts:74`, `:578`, `:603`, `:638`, `:690`, `:737`, `:762`); `PUT/DELETE /api/graph/work-items/:id/documents/:documentId` (`routes/work-documents.ts:52`, `:64`) | work item | steward | low |
| 24 | `POST /internal/devbox/:sessionId/task` (`routes/internal-devbox.ts:196`) | session | `requestedBy` may reach the box (owner, or steward of `box.projectId`); also auto-registers unknown sessions (`:213`) | high |
| 25 | `POST /internal/devbox/:sessionId/shell-url` (`internal-devbox.ts:256`) | session | same; the principal is parsed and then discarded (`:261`) | high |
| 26 | `DELETE /internal/devbox/:sessionId` (`internal-devbox.ts:327`) | session | same | medium |
| 27 | `GET /internal/devbox/boxes/:boxId/tail`, `/:sessionId/files[/:fileId]` (`internal-devbox.ts:246`, `:276`, `:298`) | box, session | the signed payload carries no principal at all, so nothing can be checked | medium |
| 28 | `POST /api/lab/signals`, `/experiences`, `/consults` (`routes/lab.ts:53`, `:80`, `:117`) | `initiativeId`, `boxId`, `sessionId` (body) | run-token binding; every box holds the same `LAB_CALLBACK_SECRET` (`infra/lib/devbox-stack.ts:258`), so a box can file under any initiative | medium |
| 29 | `POST /api/lab/consults/:id/answer` (`lab.ts:163`) | consult → box, initiative | steward or box access; an answer steers another initiative's running agent | medium |
| 30 | `POST /api/designs/:id/answer`, `/signoff` (`routes/designs.ts:42`, `:63`) | design review → `orgProjectId` | steward | medium |
| 31 | `POST /api/initiative-decks/projects/:projectId` and deck writes (`routes/initiative-decks.ts:57`, `:71`, `:72`) | initiative | `deckWriteAuthority` checks `DispatchAgentRun` only and ignores `projectId` (`lib/deck-shared/authority.ts:58`) | low |
| 32 | `POST /api/devbox/boxes` (`routes/devbox.ts:441`) | `sessionId` | box id is `sessionId.slice(-8)` (`lib/devbox-fleet.ts:311`): a collision returns the existing box's record, and an unregistered live session is adopted with the caller as owner | low |

Out of scope, checked: `/internal/document-grants/session` (epoch read, not
initiative-keyed); `/api/agents/:id/invoke` (capability gated, no initiative
target); the conversation agent loop (channel-scoped, no devbox steps,
`lib/agent-loop/index.ts:36`); `/api/observability/approvals` (amount-gated
Cedar); `POST /api/work/proposals*` and `analyze*` (graph proposals, not
initiative-keyed); SDLC policy CRUD (global today; DE-46 and DE-43).

**A stale claim:** `sme.cedar:16-19` says "the envelope/allocation brakes on
the dispatch pipeline still govern what a bot may spend". A manual
`POST /api/bots/:id/run` runs only the per-run cap, and the allocation brake
runs only for cron firings that opted in (`lib/bot-runner.ts:943`).

## Change

**One scope module.** Move `requireInitiativeSteward` out of
`routes/sprints.ts:65` into `lib/initiative-scope.ts` and add:

```ts
// 403 + false when the caller may not act on this initiative. null initiative → unattributedRule.
requireInitiativeScope(req, res, initiativeId: string | null,
  opts: { spend?: boolean; createdBy?: string | null }): Promise<boolean>
// owner === user, or userStewardsInitiative(user, box.projectId), or org-wide role
userReachesBox(userId: string, box: FleetBox): Promise<boolean>
```

`spend: true` runs `grantScopedDispatchVerdict` after the steward check, so
"may write here" and "may spend here" stay two named questions. Every check
denies on lookup failure, as `stewardsInitiative` already does.

**Resolvers, one per resource**, each next to its provider: bot →
`resolveBotInitiativeId` (export it); codebase → `orgProjectId`; change →
codebase → `orgProjectId`; job → `payload.initiativeId`; finding →
`initiativeIdForFinding`; consult → `initiativeId` or its box; design review →
`orgProjectId`. For an update, check both the current and the requested
initiative.

**Per route:** rows 1–23 and 29–31 call `requireInitiativeScope` (with
`spend: true` on 3, 6, 7, 14, 17) after the 404 and before any write, matching
the sprints order. Row 6 drops the `findingId` side effect, or runs the
promote check for it. Rows 12–14 also call the public `requireBoxAccess`
(export it) on `sessionId`. Row 22 runs the steward check on the sprint's
initiative and the same-initiative check from `sprints.ts:331`.

**Internal devbox (24–27):** after `requirePrincipal`, resolve the box and call
`userReachesBox(principal.requestedBy, box)`; refuse an unknown session the way
`requireBoxAccess` does instead of registering it. The GETs carry
`requestedBy` as a query parameter that is included in the signed payload
(platform-api changes in step; ship it behind accept-both for one release).

**Lab callbacks (28):** require the run token (`lib/run-token.ts`) as runbooks
does, and take `boxId`/`initiativeId` from the run's frozen brief, not the
body. A box running without a brief (ad hoc shell) files unattributed.

**Row 32:** derive the box id from the full session id hash, and refuse a
`sessionId` that is live in AgentCore but unregistered unless the caller is
fleet-wide.

**A matrix test** (`routes/__tests__/initiative-scope-matrix.test.ts`) lists
every row above as `{ method, path, body, initiative }` and asserts the 403
for an attached-nowhere `sme`, the pass for a steward, and the bypass for
`org-leader`. A new write route on these routers has to add a row or the test
fails on an unlisted route (walk `app._router` for the mounted paths).

## Decisions owed

- **Is `program-owner` program-wide?** Its Cedar comment says it runs the
  program "across initiatives" and allocates budgets, but it is scoped on
  sprints today. Proposal: scope it to initiatives it owns or contributes to,
  everywhere, including budgets and grants; add it to the org-wide list only
  if you want it to allocate on initiatives it does not run.
- **Unattributed resources** (a bot with no target, a codebase with no
  initiative, a finding with no initiative). Proposal: an `sme` may act only on
  ones it created (`createdBy`/`addedBy`); org-wide roles pass.
- **Re-check on internal routes, or trust platform-api?** Proposal: re-check,
  as 1eeffdc8 did; the signature proves the service, not the user.
- **Manual bot runs by an `sme`.** Proposal: the same grant verdict and
  envelope brake as dispatch-work, and fix the `sme.cedar` comment.

## Done when

- The matrix test passes and covers every row; one deny test per row asserts
  403 for an `sme` attached nowhere, plus a `program-owner` case for rows
  20–21 per the decision.
- `POST /api/work/jobs` with another initiative's `findingId` or `workItemId`
  is 403 for an ungranted `sme` and leaves the finding `open`.
- `POST /api/agent-projects/:id/runs` and `/clone-command` with a session the
  caller cannot reach are 403, and an unknown session is not registered.
- `POST /internal/devbox/:sid/task` and `/shell-url` signed for a user who
  neither owns the box nor stewards its initiative are 403
  (`routes/__tests__/internal-devbox.test.ts`).
- A lab signal signed with the fleet secret but no run token is 401, and one
  with a token files under the brief's initiative whatever the body says.
- `validate-mock-floor.sh` and the existing `sprints`, `devbox`, `bots-*`,
  `grants` and `sdlc-routes` suites stay green.
