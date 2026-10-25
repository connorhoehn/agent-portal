# Chassis extensibility implementation

Requested 2026-10-25. Complete the three refactors in their owning packages and
adopt them in aws-agentcore and realtime-modules. This is an implementation
ledger, not a claim of production acceptance.

## Detailed plan

The [source-backed implementation plan](chassis/implementation-plan.md) defines
C0–C9, package ownership, migration gates and failure acceptance. The
[dependency inventory](chassis/dependency-inventory.json) records the inspected
pins. Planning is complete enough to start C0; implementation remains pending.
The detailed plan refines the order below: extract the needed client contract
and capability checks before the durable queue migration.

## Execution order

1. Repair and verify the current hangout page, including the reported active-call
   layout, duplicate activity sections, saved layouts, temporary rooms, media
   movement and recording-summary authorization.
2. Make queue delivery and worker ownership durable. Extend existing message-queue
   stores and distributed-core fencing rather than introduce another coordinator.
   Prove restart recovery, visibility leases, delayed delivery, FIFO deduplication,
   consumer groups, duplicate delivery, stale receipts and stale-worker completion.
   Document supported replica/storage combinations explicitly.
3. Publish contracts and clients from their owners. Remove redundant BFF queue
   interfaces and room-plan validation, validate wire compatibility, and migrate
   realtime-modules and application consumers. Preserve the distinction between
   WebSocket frames and durable broker events; retain intentional domain projections.
4. Add declarative runtime capability checks to service-runtime, using existing
   distributed-core composition and readiness primitives. Integrate queue/storage/
   ownership checks in realtime-modules and both application services. Unsupported
   production combinations must fail startup or readiness with actionable errors.
5. Release owning packages, update consumer pins, run cross-package compatibility
   and failure tests, and push verified work. Local tests do not establish cloud
   deployment or capacity acceptance.

## Completion ledger

| Work | Owners / consumers | Status | Required evidence |
| --- | --- | --- | --- |
| Hangout baseline | ui-components, realtime-modules, platform-api, aws-agentcore | In progress | Real two-person media walk; active-call layout at wide/narrow sizes; unique activity region; authorization denial tests |
| Durable queue and worker lifecycle | message-queue, distributed-core; platform-api, realtime-modules | Planned | Restart and competing-owner tests against actual durable stores; duplicate/stale completion rejection |
| Owner contracts and clients | message-queue, event-catalog, pipeline-runtime, platform-api; realtime-modules, aws-agentcore | Planned | Consumer typechecks; wire fixtures; no duplicate canonical validators/interfaces |
| Runtime composition | service-runtime, distributed-core; realtime-modules, platform-api, aws-agentcore | Planned | Supported matrix passes; unsafe combinations rejected; ownership loss removes readiness |
| Downstream releases | All changed owners and consumers | Planned | Built artifacts match source; pins resolve; release checks and pushed commits recorded |

## Boundaries

- Preserve existing data and the Product review / Design studio hangouts.
- Use isolated walk identities and clean up only records created by those walks.
- No cloud deployment, business-data reset or claim of accepted production scale.
- Keep the pipeline executor in platform-api; its retired worker service is not
  restored without a demonstrated requirement.
- Do not replace working domain-specific authorization or fencing with a generic
  interface that weakens those guarantees.

## Technical debt

| ID | Decision | Status / trigger | Acceptance |
| --- | --- | --- | --- |
| TD-ESM-01 | ESM is the target across the chassis and application packages; retain CommonJS consumer compatibility as needed | Deferred. Only migrate a file already being changed for other authorized work when its package boundary safely supports it. No standalone conversion or broad configuration churn. | Future deterministic inventory + AST codemod with dry-run and idempotence checks; packed-artifact compatibility, singleton identity and consumer tests before each package release |

Accepted by the user on 2026-10-25. The
[migration policy and automation path](chassis/implementation-plan.md#esm-migration-debt--td-esm-01)
define the scope. This debt does not block the three chassis refactors.

## Evidence

Append exact test commands, outcomes, versions and remaining limitations as each
phase completes. A planned row becomes complete only after downstream adoption.
