# Product readiness in the existing AgentCore application

October 25, 2026. The target is the existing application, with its tenant structure, navigation, shared component library and real integrations. The standalone concept page was withdrawn after user feedback because it lost that context.

The backend findings and detailed acceptance journeys remain useful. The 85–90% guided-demo estimate does not describe backend or product readiness. A production percentage or schedule needs real dependency and deployment proofs before it is defensible.

- [33 detailed tenant and shared journeys](journeys.md), including recovery, permissions and durable outcomes.
- [Structured journey and backend catalog](journey-catalog.json).
- Current app: [Social Rooms](http://localhost:5183/social/rooms) and [Work Communication Rooms](http://localhost:5183/iq/communication/rooms). These routes require the corresponding workspace access.

## Contextual hangouts

The Social and Work Communication routes use the existing tenant shell and
shared UI library. A hangout now has Overview, Call, Conversation, Rooms and
Activity tabs. Its dedicated Call tab owns one media stage, with controls below
the participant grid. Conversation stays in the hangout content pane; the
unrelated far-right chat no longer squeezes the call. Configuration and activity
have separate React identities, fixing the duplicated activity regions.

The Rooms tab separates saved layouts from this call's temporary breakouts.
Hosts can name rooms, assign people with the shared person picker, choose how
people join, and allow return to the main call. Saving uses version checks;
concurrent changes are rejected rather than overwritten. Assignments do not
grant private-room access or mark a person present. Call settings govern
camera-off entry and recording for new calls.

The directory uses shared search/filter controls and cards, hides empty browse
controls, preserves upstream pagination, and resolves a selected room directly.
Opening a hangout does not start media. Activity uses actual session attendance
and authorized recording summaries; no synthetic dialogue is shown.

The [generated concepts](concepts/README.md) informed the implementation inside
the actual app. They are design references, not evidence of deployed behavior.
The [33 journeys](journeys.md) remain an acceptance backlog across all tenants.

### Verification and limits

The live local journey uses isolated manager and participant clones with
synthetic microphone/camera devices and the actual BFF, platform-api and native
media service. It creates a disposable hangout, saves rooms and assignments,
joins two people with cameras off, checks inbound audio, moves both people into
a saved breakout, adds a temporary room, returns to the main call, verifies
attendance and reloads the unchanged saved layout. Cleanup archives only that
walk's hangout and removes its clones. Design studio and Product review remain.

The browser walk also checks configuration, room editing, saved layout, call,
conversation, live rooms and activity in light/dark themes at 1440/900px. Its
28 measured states must be stable and have zero findings. The directory has a
separate deep audit covering focus, layers and intercepted data states. The final run passed 14 browser tests, all 28 hangout states and all 27 directory
deep cases (zero findings and zero unclassified composer policies). The
[verification artifact](hangouts-verification.json) records exact scope.
The platform-api release also passed 6,304 tests (15 skipped), full typechecking,
build, OpenAPI coverage and lint (zero errors; existing warnings). The rebuilt
local backend passed the two-person walk again.

The broader Social/Communication judges are **not currently green**: their
rendered measurements predate this source, and 32 Social logs plus Assessment
`stretch/realtime` require a new walk before resealing. These targeted results
do not replace those records.

Application captures: [Call](screenshots/audit-call-light-1440.png),
[narrow dark call](screenshots/audit-call-dark-900.png),
[Conversation](screenshots/audit-conversation-dark-900.png),
[saved layout](screenshots/audit-saved-layout-light-1440.png), and
[live rooms](screenshots/audit-live-rooms-light-900.png).
This is targeted hangout coverage, not acceptance of every tenant.

The backend tests cover plan validation and conditional updates, private access,
session linkage, media configuration and summary access after removal/deletion.
Activity pages are bounded and currently retain session history for seven days;
there is no historical backfill. The in-memory video-store profile is not a
durable activity history. The local native media walk does not prove AWS IVS
integration, deployment, process-restart durability or production capacity.

## Backend acceptance

Use four evidence levels: **implemented and unit-tested**, **integrated with actual local dependencies**, **deployed end to end**, and **operated under the agreed load and failure conditions**. They are not interchangeable. Passing a mocked browser journey does not advance a real integration to the deployed level.

| Area | Evidence available | Material gap | Next acceptance proof |
| --- | --- | --- | --- |
| Work | Aurora provider paths; local database contracts for selected document/thread flows; implemented policy guards and local collaboration | Work-document/comment migrations remain unapplied according to the handoff. Current complete cloud workflow is not accepted | Real sign-in → create work → attach evidence → another actor reviews → real execution → durable result after restart |
| Assessment | 61 sealed local journeys; Aurora branch; transaction/locking logic for admission and completion; stopped-run guards | Mock Aurora and AgentCore serve the current browser stack. The documented real database/runtime path needs deployment verification | Real evidence import → actual agent dispatch → authenticated completion → score provenance → consistent report; stop/restart/duplicate callback variants |
| Social and Communication | Actual local platform-api/media two-person calls and record/play/delete; chat store abstractions and prior persistence contracts | Current gateway reports memory storage. Live-platform rooms, teams, recordings and calls are not indexed without a caller token | Durable message/read state through process replacement; private room enforcement; media reconnect; durable recording lifecycle; searchable live objects |
| Pipelines | Real-provider projection and explicit unavailable-source reporting; Aurora definitions/configuration paths | Aggregating runs into one ledger does not verify execution, approvals and recovery for each producer | For every supported producer: exact version → dry run → separate approval → actual queue/runner → artifact → cancel/retry/restart |
| Access | 11 native PostgreSQL contract tests passed on October 19, including concurrent decisions, provisioning and grant changes | `providers/access.ts` calls `store()`, which throws 503 when mock Aurora is off. The provider needs implementation/wiring; applying the schema alone is insufficient | Real persistence through the running routes; approval → entitlement → session enforcement → expiry/revoke; crash recovery and audit |
| Identity and client isolation | Product-workspace grants, route/API guards and realtime authority logic | A product tenant such as `social` is not proof of isolation between client organizations. Current local sign-in does not prove actual client SSO | Real provisioning/login/revocation; agree isolated client deployments or a shared organization partition and test accordingly |
| Operations | Infrastructure and validation machinery; prior local acceptance records | Current deploy/rollback, restore, dependency health, target load and operational ownership are not accepted by this review | Staging deployment and rollback; restore a backup; replace workers/services during operations; verify alerts and agreed recovery objectives |

Live local health on October 25: `aurora`, `agentcore`, `guardrails` and `cloudwatch` mocks all true; realtime gateway on with `store: memory`. Its overall healthy status therefore does not establish live AWS integration. AWS credentials were **not** refreshed or tested in this review; the older credential problem remains a recorded deployment risk, not a newly measured failure.

Source anchors:

- [Provider selection](../../../middleware/src/providers/index.ts), [Access store guard](../../../middleware/src/providers/access.ts), [Access SQL proof](../../realtime-validation/2026-10-19/access-postgres.md).
- [Assessment persistence and dispatch boundaries](../../assessment-tenant.md), [deployment facts](../../../CLAUDE.md).
- [Social platform authority and backend selection](../../../middleware/src/providers/social-platform.ts), [search indexing boundary](../../../middleware/src/lib/search-index/social.ts), [gateway storage selection](../../../middleware/src/lib/realtime-gateway.ts).
- [Pipeline projection](../../../middleware/src/providers/pipeline-runs.ts), [definition persistence](../../../middleware/src/providers/pipeline-definitions.ts).
- [Latest regression and local flow verification](../../codex-handoff-2026-10-23.md).

## Remaining acceptance

The catalog contains proposed acceptance journeys, not a claim that every behavior exists or passed. Actual cloud deployment, Access provider integration, durable process-restart behavior and the live search boundary still need work. This Rooms change does not close those backend gaps.

Inspection evidence is kept under `.scratch/product-readiness/`. The earlier read-only inspection covered 11 routes; its initial Work capture had a selector assumption corrected on rerun. Temporary review clones were removed. No shared mock reset or cloud operation was used.
