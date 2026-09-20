# Repository audit — September 19, 2026

Status: resumed after publishing checkpoint `f837bd68` to main. See
[the continuation handoff](handoff-2026-09-19.md). This is an evidence ledger, not a
certification that every feature or deployment path is correct. Counts below
identify specific checkpoints; the clean final middleware/portal runs are recorded below; browser acceptance
remains incomplete.

## Scope and source state

The user requested a repository audit, following existing instructions, and
subsequently authorized fixing the findings and pushing the reviewed result.
The root `CLAUDE.md` and relevant feature contracts were followed. No `AGENTS.md`
was found. Initial fetch and fast-forward pull put HEAD and origin/main at
`818b6ba`, with no divergence. Final remote verification and publication remain
the integrating agent's responsibility.

The work now includes dependency updates, local Docker builds, isolated mock
servers, browser observations and source/test changes. No live AWS deployment,
Aurora migration or AgentCore invocation is claimed. Existing card-elevation
work was preserved and corrected. Existing user sessions and servers were kept
separate from audit sessions. Generated evidence is not renewed merely because
a file has a recent modification time.

## Confirmed defects and changes

| Area | Confirmed defect and resulting behavior | Evidence |
| --- | --- | --- |
| Session authentication | Production picker access depended on Cognito configuration. Both passwordless login and directory now require explicit demo mode. Revoking a final grant clears the old identity/cookie. | Picker and session regression tests |
| Machine authentication | Missing or blank callback secrets admitted production writes. Production now returns 503; configured secrets still require a match. | `service-auth-guard.test.ts` |
| Authorization cache | Decisions could be reused between different principals sharing a role. Principal ID is part of the structured key. | `authz-cache.test.ts` |
| HTTP boundary | Rate limits used spoofable XFF; credentialed CORS reflected arbitrary origins. Limiters use Express's client address with explicit deployment proxy trust; an origin allowlist runs before session/routes. | Direct/trusted-proxy spoof tests and nine origin-policy cases |
| WebSocket/gateway boundary | An unauthenticated dummy `/ws` endpoint and generic service-signed channel proxy provided misleading or unsafe behavior. The stub is removed, unsupported upgrades rejected, and retired generic proxy routes return 410. | Upgrade/proxy regressions; `ws` upgraded |
| Offline gateway | An absent endpoint constructed clients and retried connections. The optional provider and shared endpoint resolver use an honest disconnected context without opening sockets or polling; actual sends fail clearly. Explicit configured endpoints use the installed provider. | Optional-provider and endpoint tests, including lifecycle subscription behavior |
| Outbound network | Same-origin link filtering did not cover initial targets, redirects or DNS rebinding. Survey/crawl HTTP requests now validate every hop, reject nonpublic destinations and credentials, pin approved DNS addresses, and bound time/body/redirects. | 58 tests across four outbound/degraded-path suites; [network policy](crawl-network-policy.md) |
| Remote browser | Browser mode was assumed rather than verified. The configured AgentCore browser must report PUBLIC mode; unknown/VPC/error states fail closed, and initial navigation is validated. | SDK-stub tests. This relies on AWS's documented PUBLIC network isolation, not interception of every browser subresource; precise limits are in the network policy |
| SQL credentials/tools | Model-authored reads could use an admin credential, and prefix-only SQL checks allowed unsafe EXPLAIN forms. Reader credentials are required outside an explicit development fallback; shared SQL validation covers gateway tools, quoted forbidden functions and escape-string forms. Pagerank write-back is rejected. | Python guard/helper/agent tests and infrastructure packaging tests; no live database privilege test claimed |
| Local notebooks/builds | Jupyter disabled authentication and published broadly; npm disabled certificate checks; Docker used unverified sibling outputs. Token authentication and loopback publishing are restored, TLS verification is enabled, and Docker inputs come from exact locked Git commits. | Four successful local image builds; runtime check status recorded below |
| Offline trace pipeline | Mock startup attempted live AWS trace polling. Polling is disabled when offline or a required pipeline dependency is mocked. | No-network tests and isolated mock boot |
| Assessment persistence | A failed insert could commit the preceding supersede; completion provenance could mark the wrong envelope processed; late presence leave could remove a newer entry. Rollback crosses the transaction boundary, processing requires the selected envelope/run history, and ordered presence ignores stale events. | Rollback, provenance, status and broker regressions |
| Assessment workflow | Real launches had no durable dispatch and admission/completion raced. Runs now capture typed input, reserve atomically, dispatch through a worker, and serialize completion/stop with a row lock and shared transaction. | Transactional-fake and SDK-stub regressions. Independent review found four further issues, now repaired and regression-tested: log collisions, cross-run team locking, N/A claims and selected-dimension scope. Clean local integration passed; no live Aurora/AgentCore result claimed |
| Assessment UI/data | Unknown-team duplicate submissions were missed after assignment; fallback certification included N/A dimensions; synced document comments/reactions returned false 404s. Team duplicate metadata, applicable denominators and canonical document resolution correct these cases. | Portal/provider regressions; comment schema FK now targets knowledge nodes and requires deployment migration |
| Evidence integrity | Validators renewed stale evidence from mtimes. Normal runs compare content digests without changing stored hashes; sealing is explicit and must follow actual review. | Validator changes and stale-record findings; historic browser observations are not retroactively renewed |
| Presentation | Global resting-card shadow overrode explicit floating shadows. Defaults now live in the components layer. The document explorer now has persistent rail collapse and adjustable context width, search, folder table, ancestry, actual-heading outline, reading width, rendered word count, copy link and Markdown download. Team pages expose metadata/review, full certification text, explicit progress/evidence disclosure and searchable dimension navigation. | Portal tests/build and recorded browser observations; current redesign still needs final verification |

## Verification checkpoints

### Resumed checkpoint

After resumption, fetching origin left local main four commits ahead, including
the `codex/active-now-integration` merge. Its five new work-graph files are
structural cloud/local compute mappers; they do not yet wire a live projection.
Review found and repaired same-millisecond box status event-ID collisions and
invalid session timestamps that could throw during conversion. The two mapper
suites pass all 28 tests, and middleware typecheck passes. These focused checks
cover the new addition; the full-suite counts below describe the earlier
checkpoint. The resumed assessment quick validator still reports 40 stale
journey records, with its other checks passing.

Deployment review found two further gaps: the comment FK replacement could
commit its DROP before a failed ADD, and reader credential setup could return
success when its secret was unavailable. The FK replacement is now atomic;
reader setup fails closed and offers `--readonly-role-only` to avoid replaying
demo data. All 68 relevant local tests pass. An isolated PostgreSQL 16 check
executed the actual migration, proved failure preserves the old FK and rows,
then proved successful reconciliation, synced comments, cascade and rerun.
The container had no network/ports/host mounts and was removed. This does not
establish live Aurora/Data API behavior. See the
[upgrade runbook](deployment-upgrade-2026-09-19.md).

The resumed explorer audit reproduced a duplicate keyboard-handler defect:
the installed library already implements tree navigation, while a retained
local shim also handled the same keys. Right Arrow on a leaf moved to a
sibling. The shim and its unused helpers were removed; the wrapper retains
double-click rename. Portal tests now pass 914 cases (seven retired shim tests
removed), with typecheck/production build and component discipline passing.
The assessor team-scorecard protocol was fully repeated; its individual record
now includes all tabs, native keyboard traversal, dialogs and missing-team
behavior. Other role records do not inherit this acceptance.

The assessor workspace protocol also passes after the fix: Tab reaches the
tree, leaf Right Arrow stays put, row movement and expansion occur once,
outline selection focuses the real heading, search and persistent collapse
work, and the page has no viewport overflow. Its current screenshot was
inspected. The assessment quick validator now reports 38 stale records, down
from 40; its other checks pass. The OrgIQ, branding and distillation freshness
gates remain failing (24, four and two records respectively).

The wizard's pending duplicate-rematch check could not be completed in this
pass: its previous draft state was gone, and CUA lost the native window during
the fresh-import attempt (`cgWindowNotFound`). No new Parse/commit or rematch
result is claimed, and its digest remains unchanged. Browser work stopped;
the isolated preview servers remain available on API 3018 / Vite 5198.

Working logs are in `/tmp/aws-agentcore-audit/`; those temporary files may be
removed by the OS. These are checkpoint results, not a claim that every test
below ran against the eventual final tree. Overlapping targeted suites must not
be added together as a unique test total.

| Check | Latest recorded result and limit |
| --- | --- |
| Full middleware integration | Clean final run: 293 suites and 4,243 tests passed (`middleware-final-clean.log`, 367 seconds). Earlier scanner, schema-shape and timestamp-only provenance fixture failures are repaired. |
| Portal | Frozen UI checkpoint: 921 tests passed (`enterprise-ui-tests.log`); matching typecheck and production build passed. The final portal image also builds and serves its generated assets. Vite chunk-size warning remains. |
| Infrastructure | 197 tests passed in integrated/gateway runs; build completed. These are local checks, not deployment verification. |
| Python | Shared security helpers: 230 passed. Agent regression directory after dispatch changes: 264 passed. SQL guard: 37 passed; drafter document tests: 34 passed. Earlier devbox 6, supervisor 5 and scorer 38 checkpoints passed. |
| Assessment rereview | Baseline 502 tests/32 suites passed. Targeted rollback/provenance/status/presence/comments: 54 passed; later provenance/rollback: 16 passed; synced comments: 25 passed. Portal rereview: 196 passed. |
| New dispatch/atomicity | `assessment-dispatch-new.log`: 11 passed; `assessment-completion-atomic.log`: 22 passed; `assessment-atomicity-new.log`: three passed, covering concurrent completion, rollback and stop winning the lock. After independent review repairs, `assessment-review-final.log` passed six suites/138 tests; later lock-order checks passed. Fakes/stubs do not prove live Data API or runtime behavior. |
| Docker | Middleware, portal, AWS Jupyter and GCP Jupyter images built successfully from the revised build inputs. Both Jupyter images were run in isolated containers without mounts or published ports: anonymous API requests were denied and the runtime-generated token returned 200 (integrating agent tool transcript, exit 0; containers removed). The final portal rebuild also passed: isolated runtime HTML and application bundle returned 200 (`docker-portal-runtime-final.log`). Final middleware image rebuild passed (`docker-middleware-final.log`); its isolated production runtime returned health 200, picker login 403 and an unconfigured machine callback 503 (`docker-middleware-runtime-final.log`). |
| Mock wire evidence | Final isolated capture completed: 224/270 GET routes and 103/219 write routes, with 18 field vocabularies (`wire-capture-final.log`). Uncaptured routes include streams, missing discoverable parameters, write-dependent claim tokens and unconfigured live dependencies; they are explicitly listed. Mock-floor verification passed after repairing a stale provenance test fixture, including builds, fixture tests, scanner checks and captured handler digests. Source provenance was recaptured again after the final lock-order tweak. |
| Validators | Final quick checkpoint plus targeted repair rerun: seven pass (agent-eval, component-discipline, honest-numbers, nav-parity, route-coverage, newsroom-removal, mock-floor); four fail only evidence freshness. Only the dated assessment source-review record has a renewed digest. Partial browser passes retain their previous digests until the full required interactions are repeated; the prior checkpoint counts therefore do not represent completed acceptance. Mock-floor originally failed a timestamp-only provenance fixture; the fixture now covers envelope/run/history linkage and the full quick gate rerun passed. The newsroom archival-path scanner conflict was repaired and its full quick gate passed. Fresh re-observations remain pending. No hashes were sealed by these runs. |

## Dependencies and build provenance

The original independent OSV scan found 25 affected public npm package/version
pairs and 44 advisories. After lockfile updates, all 1,133 unique public npm
pairs were queried again: **zero affected pairs were returned**. This replaces
the earlier unresolved npm finding, not a guarantee of vulnerability-free
software. npm's advisory endpoint had returned HTTP 503. See the
[dependency audit](dependency-audit-2026-09-19.md) for exact versions, scoped
transitive overrides and reproducible query evidence.

Internal libraries remain pinned to full Git commits. Local Docker preparation
exports those committed objects rather than copying arbitrary sibling build
outputs. Installs keep TLS verification enabled and disable lifecycle scripts.
Telemetry constructor/shutdown and CommonJS cron compatibility were exercised;
live telemetry export and Cognito sign-in were not. The OSV result excludes
Python packages, internal Git dependencies and container OS packages.

Lifecycle inspection covered protobufjs's compatibility check, esbuild's
platform binary installer/download fallback and lz4's native build entry point.
No unexpected external destination was found in those entry points. This is not
verification of every native source or downloaded binary.

## Visual and review evidence

Fresh browser observations cover both tenants in light and dark themes. The
OrgIQ light six-route rhythm sweep and assessment light/dark seven-route sweeps
were observed. The OrgIQ dark sweep needs a clean repeat after HMR interrupted
its measurement; a screenshot alone does not replace that check. New PNGs in
`docs/branding-journeys/` document observed states, but branding records have not
been sealed while redesign is active.

Member work, findings, designs and settings were also observed in an isolated
browser session, with dated partial observations and screenshots. Their previous source
digests were restored because the full journey protocol was not repeated. Further browser automation paused when Chrome reported active
user interaction; unfinished observations were not replaced with source-only
claims. Other roles and newly changed explorer/team interactions still need current
browser evidence. Separately, `isolation-api-final.log` records eight seeded
roles each receiving 403 for three cross-tenant GETs and a forbidden tenant
switch, plus a denied assessment request for the development fallback identity.
These are API checks, not browser observations. Nine optional Tiptap peers were installed and runtime/build probes passed. A
rich-editor migration was not performed: its section/Yjs document model needs a
contract with the BFF Markdown store. The missing typed-documents build entry
remains queued. Historical journey counts and screenshots are not proof that
the new UI passes. Six assessor surfaces have dated presentation/interaction observations, with
screenshots. Their previous digests were restored pending the full protocol.
The wizard additionally exercised upload, matching, commit, evidence skip,
processing and duplicate reparse; the final manual rematch check remains open.
These partial observations do not renew full role acceptance. The separate
[assessment review](assessment-journeys/REVIEW-2026-09-05.md) now has a final
dated source-review appendix and an individually renewed source digest after
reviewing the dispatch repairs. Its old browser claims remain historical.
No other role or stretch record inherits that review.

## Remaining acceptance work and limits

1. Complete current UI verification and integrated checks. Independent dispatch
   review repairs are present and regression-tested: scoring logs use unique
   suffixes; run and human score application share a team lock; N/A claims
   produce pending exceptions; selected submission dimensions constrain output.
   Lock order was also corrected before child foreign-key inserts.
2. Preserve the clean middleware/portal results and refreshed mock capture.
   Seven quick validators pass; complete browser evidence before rerunning the
   four remaining freshness gates. Rerun code checks only if further fixes change
   their inputs. Record failures as failures until resolved.
3. Complete fresh role/journey and redesign observations before sealing their
   records. Content freshness proves which code was reviewed, not review quality.
4. Verify schema migration/deployment requirements, review the combined diff,
   verify remote state, and publish only the actual reviewed result.

No live Aurora transaction, new migration, AgentCore execution, PUBLIC-browser
isolation exercise or production SSO flow has been performed. Stopping a run
fences persisted completion; it does not prove immediate cancellation of remote
model execution. Retiring the generic gateway proxy closes that path, but does
not establish membership enforcement for a future external realtime service.

A historical pattern scan covered 8,980 reachable Git blobs (202,311,083 bytes)
and found one AWS-key-shaped test fixture match. It covered AWS IDs, PEM private
key headers and selected GitHub/Slack/OpenAI token formats. Generic passwords,
arbitrary secrets, untracked files and unreachable objects were outside scope.
No claim that the repository contains no secrets follows from that scan.

## Resumed checkpoint: durable comment replies

The user resumed implementation after the earlier pause. Document comments now
support durable quote replies through the installed ChatComposer, ChatPanel
composer slot and QuoteBlock. The backend validates an existing, undeleted
parent in the same document, under a transaction lock. Parent links cannot be
changed by edits. Soft-deleting a parent preserves its replies and displays a
tombstone instead of its quoted body. These are chronological quote replies;
a nested thread view and rich document editor migration remain unfinished.

The frontend retains newer edits and deletion tombstones when the bounded SSE
feed rolls over or an older GET completes. It refreshes on comment mutations,
reconnects and stream gaps. Failed posts retain the draft and reply target;
failed edits reject back to the toolkit so its editor remains open.

Validation: all 923 portal tests pass; 103 targeted backend tests and middleware
typecheck pass. Mock-floor quick validation passes after an isolated capture
witnessed nullable/string parent IDs (224 GET and 103 write routes). Browser
observations establish seeded quote rendering and the accessible multiline
composer only. Posting, reload, parent edit/delete and simulated failure journeys
remain unverified because Chrome was actively in use. No new browser seal was
applied. The wizard duplicate-rematch step was observed separately; its journey
records the exact behavior without sealing the whole protocol.

Apply the additive assessment comment parent migration before deploying this
feature. No live migration or deployment was performed. Unrelated work-graph
and dependency changes from a concurrent session are outside this checkpoint.
