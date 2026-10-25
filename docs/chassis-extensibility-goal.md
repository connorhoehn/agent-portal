# Chassis extensibility implementation

Requested 2026-10-25. Complete the three refactors in their owning packages and
adopt them in aws-agentcore and realtime-modules. This is an implementation
ledger, not a claim of production acceptance.

## Detailed plan

The [source-backed implementation plan](chassis/implementation-plan.md) defines
C0–C9, package ownership, migration gates and failure acceptance. The
[dependency inventory](chassis/dependency-inventory.json) records the inspected
pins. C0 is in progress; the first four queue delivery defects reproduced on
DynamoDB Local. The catalog poison-source deletion is repaired and released; shared-client and
capability work has started. Queue storage repairs and downstream chassis
adoption remain pending.
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
| Hangout baseline | ui-components, realtime-modules, platform-api, aws-agentcore | Targeted release verified | Real two-person media walk and 28 layout states pass; backend authorization checks pass. Broader tenant journey freshness still needs renewal (see product-readiness record) |
| C0 failure characterization | message-queue; remaining catalog/job harnesses | In progress | Four queue defects reproduced against an owned local DDB table; positive send/ACK control passed; cleanup confirmed; remaining scope in the verification record |
| Durable queue and worker lifecycle | message-queue, distributed-core; platform-api, realtime-modules | In progress | Restart and competing-owner tests against actual durable stores; duplicate/stale completion rejection |
| Owner contracts and clients | message-queue, event-catalog, pipeline-runtime, platform-api; realtime-modules, aws-agentcore | In progress | Consumer typechecks; wire fixtures; no duplicate canonical validators/interfaces |
| Runtime composition | service-runtime, distributed-core; realtime-modules, platform-api, aws-agentcore | Library released; host adoption pending | Supported matrix passes; unsafe combinations rejected; ownership loss removes readiness |
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

### 2026-10-25 — active implementation goal

The three chassis improvements are the active Codex goal. The hangout baseline
release is complete; chassis C0–C9 acceptance remains the completion boundary.

- **C0 / early C6:** event-catalog `0f979fa` (0.8.8, pushed) stops deleting a
  poison source on the strength of its process-local diagnostic buffer. A real
  loopback HTTP regression failed before the fix (unexpected source DELETE),
  then passed after replacing the subscriber and its diagnostic buffer. This
  proves subscriber policy, not broker disk durability. All 149 suites / 3,139
  tests pass, as do lint, build and eight-export/four-bin dist verification.
  Full C6 (heartbeat, drain, FIFO, owner client) and consumer adoption remain open.
- **C2 foundation:** service-runtime `0776e24890478b9a3098bd132c47f086e0e6994a`
  (v0.5.0, pushed) adds pure capability evaluation/assertion and a lean signing
  entrypoint sharing the existing implementation. All 19 suites / 356 tests,
  typecheck, lint (13 existing warnings, no errors) and build pass. Packed
  native Node 20.0.0 and 25.9.0 import/require checks confirm class/function
  identity and no telemetry/JWT/logging imports through the two new subpaths.
  This is static evaluation only; host profiles and live readiness remain open.
- **C1 in progress:** MQ owns the new HTTP client and browser-safe wire types.
  The owner client is now released and adopted by the BFF (details below).
  Catalog adoption remains part of C6. Inspection also found catalog's GET receive query
  names differ from the broker's camelCase names; adopting the POST receive
  contract will remove that drift.

Evidence commands: event-catalog `npm test`, `npm run lint`, `npm run build`,
`npm run verify:dist`; service-runtime `npm test -- --runInBand`,
`npm run typecheck`, `npm run lint`, `npm run build`, `npm pack` and native
import/require of the extracted tarball. Raw local logs are under `.scratch/`
with the `chassis-catalog-` and `chassis-runtime-` prefixes. No shared data reset
or cloud operation was used.

### Foundation release and first consumer adoption

- **C1 owner:** message-queue `dd97a694d3528e11b55f405af97a30b62b559abd`,
  tagged v0.3.0, publishes client/types subpaths. The full owner suite passed
  127 suites / 1,522 tests; seven environment-gated suites / 42 tests skipped.
  This includes a real signed HTTP client-to-broker lifecycle. Packed Node
  20.0.0 and 25.9.0 import/require checks and browser compilation with no Node
  types pass. The Git consumer install built the ignored dist successfully.
- **BFF adoption:** `lib/mq-client.ts` is a compatibility re-export, replacing
  the independent HTTP implementation. The memory fixture now supports receipt
  renewal/rotation, abort-before-mutation, delayed FIFO heads and strict ensure;
  unsupported consumer-group subscriptions fail explicitly. The middleware pins
  MQ v0.3.0 and service-runtime v0.5.0 at full SHAs. Installing MQ also resolved
  additional server-package dependencies; runtime import isolation is verified,
  but the subpath does not make its npm dependency tree client-only.
- **Application verification:** typecheck/build and 19 focused queue tests pass.
  The full middleware run had 540 passing suites / 7,495 passing tests, nine
  skipped suites / 56 skipped tests, and two stale route-record failures from
  the earlier hangout release. Static enumeration refreshed all 811 routes;
  the two PATCH routes were recorded as refused by existing policy, with a
  separate refusal-review timestamp. No HTTP response was invented or write
  replayed. All seven wire suites / 79 tests then passed. The entire middleware
  suite was not repeated after this metadata-only correction.
- **C2 queue host checkpoint:** message-queue
  `e8a336df4d9784f77a6181772b9116e612231c58` is pushed after the v0.3.0 tag.
  It preflights profiles/counts before stores/listeners. Seven profile tests
  (including a child-process startup with zero storage requests), 21 storage
  factory tests, two readiness-contract tests, build and changed-file lint pass.
  This is unreleased server work; the BFF remains pinned to the client release.
  Legacy DDB offers body persistence, not complete durable delivery, so durable
  profiles intentionally remain unavailable until C3–C5 acceptance passes.
- **C3–C5 design:** the owner records transaction boundaries, queue/subscription
  generations, FIFO head progression, bounded materialization and migration in
  `message-queue/docs/delivery-state-v2.md`. This is a design, not an implemented
  store or scale claim. Keep the new store in a distinct schema namespace.

The local middleware watcher was restarted after dependency installation left
it without the new package during resolution; `/api/health` on 3001 and portal
5183 return 200. No shared reset endpoint or cloud operation was used. The
user's original ui-components lock remains byte-identical to its backup.
Event-catalog consumer pins, C3–C7 delivery/job work, C8 reusable room contracts
and composition, and the C9 end-to-end release gate remain open. The earlier
broad tenant journey freshness limitations still apply.
