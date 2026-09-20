# Document workspace checkpoint — September 20, 2026

## Read this first

The user requested a written checkpoint, work log, procedures and roadmap so
another session can resume. This is an implementation checkpoint, **not a claim
that the whole feature is accepted or deployed**. Estimated completion is **85%**
of the integration scope; that is a judgment, not a measured test percentage.

**Latest explicit restriction: do not push to
`agentic-assessment-accelerator`.** Earlier accelerator commits had already been
pushed before that instruction. Their latest known SHA is recorded below. Do not
interpret the earlier cross-repo authorization as permission to push there now.
This checkpoint is committed locally in `aws-agentcore`; no cloud deployment,
live database migration or Confluence publication is part of the checkpoint.

The Active Now screenshot was sent to the wrong chat. Active Now/WorkGraph and
concurrent messaging work are outside this feature. Preserve their dirty files
in sibling repositories. Do not reset, stash, stage or release them incidentally.

## Intended outcome and constraints

Use the actual document toolkit demonstrated at `localhost:15174/documents/...`
inside `/assessment/workspace`, retaining the accelerator's useful navigation
and source workflows. Reuse shared components and services rather than building
a parallel editor, workflow backend or UI that must be replaced later.

Read root and owning-repo CLAUDE.md/AGENTS.md before resuming. Root AGENTS.md was
absent during this work. The root CLAUDE.md records a user-authorized exception
allowing fixes in the owning sibling repositories for this integration. The
user explicitly authorized parallel agents. Existing instructions about
verification and preserving other work still apply. Do not apply AWS changes.

## Current feature status

| Area | Implemented and verified | Still needed |
| --- | --- | --- |
| Shared document UI | Actual CanvasDocumentView/TipTap paper editor, shared header, outline, context sidebar; local draft edit, durable Saved receipt, reload and separate reader verified | Final visual acceptance across remaining roles and narrow document layouts |
| Navigator | New page/Add child local draft plumbing, expansion persistence, shared TreeView drop positions; real before/after pointer drops persisted | Complete inside/cycle/permission browser cases; real remote moves require configured source bridge |
| Discussion | Durable comments/replies, edit/delete confirmation and per-actor reactions verified | Broader multi-role/accessibility regression pass |
| History | Explicit owner, named binary checkpoint, preview, confirmed restore and second-reader verification passed | Additional concurrent-edit/restore race acceptance |
| Reviews/lifecycle | Verified directory assignment, reviewer approval persisted; owner cannot decide for reviewer; locked edits/restores/uploads rejected in service tests/live probe | Complete rejection/cancellation/error UX matrix; section-scoped items need real anchors |
| Recovery | Shared durable receipts, pending state, scoped sessionStorage recovery, explicit recover/download/discard implemented and unit-tested | Browser fault injection failed to intercept a write; recovery browser proof remains unverified |
| Images/tables | Canonical schema/converter preserves images/tables; protected image routing and upload-origin fix shipped; toolbar/table insertion reachable | Current real image upload returns HTTP 500; fix storage write path, then prove image and table reload + second reader + source round-trip |
| Source workflows | Trusted import, reviewed binary projection, revision/hash conflict protection, explicit publication, attachment staging and idempotent new-page journal implemented | Accelerator Python tests blocked by missing uv; no actual Confluence publish/pull/attachment acceptance |
| Deployment | Owning Dockerfiles, exact source archives, all five image builds, pinned Redis, opt-in CDK and synth tests | Run assembled acceptance on newly source-tagged images; production migration/configuration and deployment remain separate |
| Certification page | Shared responsive layout and mobile navigation; desktop/tablet/phone browser audit passed | Full historical role-by-surface audit matrix remains stale |

## Architecture and invariants

1. The BFF maps a source ID to one opaque document UUID in Aurora. Concurrent
   first opens converge. The original source hash is immutable; successful
   publication advances a separate comparison base. Production draft creation
   inserts node/document/verified-creator mapping atomically. Mock draft metadata
   is registered but resettable on process restart.
2. The BFF seeds the canonical binary document using a seed-only internal grant
   and waits for durable acknowledgement. Reopening never rebuilds an existing
   document from Markdown. Migrated documents reject legacy Markdown writes and
   restores. An unavailable document service leaves a read-only source fallback.
3. Browser grants are document/tenant/subject scoped and contain read/comment,
   plus edit when authorized. Browser grants never contain seed/manage. Current
   session epoch and authoritative identity are checked. The private epoch
   callback requires its service secret even in development.
4. Ownership comes from verified creator or explicit workflow authority, never
   CRDT `createdBy`, connection clientId or first reader. Platform delegated
   identity verification precedes its general Cognito gate without opening
   unrelated endpoints.
5. Gateway consults platform lifecycle policy for each mutation. Approved or
   finalized content refuses edits, restores and uploads. This is per-operation
   authorization, not an atomic cross-store fence: an already in-flight write
   can cross a concurrent lifecycle transition.
6. Source preview/publish uses Markdown derived from an acknowledged named binary
   snapshot. Publish binds the reviewed projection hash and source revision;
   stale content/base gets 409. Changed upstream content requires reconciliation,
   not an automatic binary overwrite. Remote-success/local-refresh-failure is
   explicitly reconciliation-needed, not a safe blind retry.
7. Source images are read through an authorized BFF asset proxy. Gateway upload
   URLs have no embedded tokens. Bearer headers are limited to trusted gateway
   upload paths; external presigned storage never receives that bearer. Source
   publication stages only scoped gateway assets with size/MIME/signature checks.
8. Recovery is scoped to tenant + subject + UUID and requires explicit consent.
   It must never silently reapply old content after an intentional restore.

## Work log and commit map

This is grouped by completed work, not a fabricated minute-by-minute timesheet.
Use `git show <sha>` for exact edits; later commits supersede earlier details.

### Research and shared composition

- Inspected the examples editor, ui-components exports, realtime modules,
  platform workflows and accelerator converter/source UX. Findings and original
  plan: [reuse research](document-workspace-reuse-research-2026-09-20.md),
  [backend integration](document-backend-integration-2026-09-19.md), and
  [deployment research](realtime-middleware-deployment-research-2026-09-20.md).
- `09bd388c`: shared workspace rails and docked document tools.
- `af346c5b`: repaired canvas converter adoption and UX reuse plan.
- Shared UI contracts cover protected images, document header/outline/history,
  TreeView drop positioning and reusable DocumentReviewPanel. The latest adopted
  release is UI **2.331.3**, `9ef190a95b43c38e3d267566c892cb18f55f4425`.
  Source review panel commit: `7a7d133c719f75aa60fd0854653247c77096b1c3`.
  This added public export should use a minor release under the owning policy;
  another session already has a dirty 2.332.0 release. Do not overwrite it or
  accidentally release its unrelated chat changes. Coordinate a later clean pin.

### Canonical documents, source and authority

- `9f5bbc0e`: mapping, authoritative identity delegation, trusted seed, projection
  and source routes, canonical canvas integration and committed-artifact installer.
- `62a5d0d0`, `4c193e36`: source bridge and normalized canonical pull baseline.
- `57420c59`: owned drafts and configured-source reads, honest unavailability.
- `1673a9fb`: protected image staging and safe local-to-remote association.
- `99e48c47`: tenant/permission hardening, scoped upload IDs and source parent.
- `ff63abf7`: durable boundary evidence, source movement and mock-floor treatment.
- Realtime modules adopted SHA:
  `99eb8c3b7a8aaa05d75f7215e06bbe554afdfce5` (0.69.4). Includes scoped grants,
  binary seed/export schema, durable receipts, recovery and relative upload fix.
- Accelerator latest already-pushed SHA:
  `f21929031b3d6033ba3ecc1d209d499fd2e329ac`. Internal source bridge delegates
  existing converter/Confluence workflows, validates scope/revision/cycles,
  handles attachments and journals new-page publication retries. **No further
  accelerator push is authorized.** Tests there remain unrun; see blocker below.

### Workflows and deployment

- `3e6d4131`, `47d282be`: narrow BFF workflow operation allowlist, verified
  reviewer assignment, ownership/lifecycle and named binary version save/restore.
  See [workflow bridge](../middleware/docs/document-workflow-bridge.md).
- Platform API adopted server SHA:
  `9c0c96f428d982ce88e4011ec37a3ca573b0b29e`.
- Examples gateway source pin:
  `907991255b1426f3051d943dda853dc42313609b`.
- `6dabc0cb`, `67ab42de`, `5dae9251`: optional AWS CDK service composition,
  private identity callback, source steward and BFF-only source credentials.
- `0a68b72c`: reproducible Docker source archive builder and five-image evidence.
  Exact sources are in `scripts/docker/document-workspace-sources.json`.
  MQ: `46fd5e01915d6c736717431fca6b79523073eaf8`;
  managed store: `48bf83451ee58421da2a707a16bf56020faa4f89`;
  event catalog: `b0bff824021a97945be331225519845b0fadf918`.
  Catalog's build-time UI pin is 2.331.2/`79bdd2ba`, intentionally independent
  from the portal's newer document UI.

### Portal and certification checkpoint

The code included with this handoff replaces the old DocPane Markdown writer
with CanvasDocumentPane and extracted adapters: DocumentHistory,
DocumentNavigation, DocumentReviews, NewDraftDialog, SourcePublishControl,
useDocumentWorkflow, useKnowledgeDocumentThread, canvasRecovery,
useCanvasRecovery, documentAssetRoute and documentCanvasState. It also pins the
verified libraries and fixes actual Vite CommonJS peer optimization requirements.

- `feadb45d`: certification narrow-screen fix using shared MasterDetail and
  DropdownMenu navigation, wrapping header and metadata.
- `4828fe0b`: final clean certification evidence after launcher correction.
- The portal launcher now blanks a stale global `VITE_GATEWAY_URL` by default;
  document sockets use their own BFF grants. No user `.env.local` was overwritten.

## Verification ledger

| Check | Result at checkpoint |
| --- | --- |
| Full middleware Jest | **313 suites, 4,404 tests passed**; `/tmp/document-middleware-accepted-suite.log` |
| Portal checkpoint rerun | **931 tests passed**, TypeScript + production build passed; `/tmp/document-handoff-portal-*.log` |
| Mock floor | Passed, including current 516-route snapshots and handler hashes; `/tmp/document-mock-floor-accepted.log` |
| Realtime clean archive | **113 suites / 1,374 tests**, build, 29 export checks and contract typecheck passed; rebuilt dist matched committed artifacts |
| Shared UI release gate | Agent reported **791 suites / 8,516 passed / 2 skipped**, source/demo lint and build passed |
| Platform/gateway | Production builds and focused authority/lifecycle/upload tests passed; platform full test typecheck still has unrelated pre-existing errors |
| Infrastructure | 201 infra tests plus 5 source/document synth tests passed; no AWS apply |
| Docker build | Five owning images built; pinned Redis pulled; source isolation and missing-sibling tests passed |
| Broad old UI validators | Assessment/branding/distillation journeys contain stale digests; do not claim every validator green or rewrite evidence blindly |
| Accelerator Python | **Not run — uv unavailable** |

Browser evidence is in
[document acceptance](research-evidence/document-workspace-2026-09-20/README.md)
and [certification journey](research-evidence/team-certification-2026-09-20/journey.md).
Certification was checked at 1500/768/390px: no horizontal overflow, tabs,
filters, keyboard selection, mobile navigation and missing-team state passed.
TEAM-001 had no page/console errors; TEAM-999 intentionally returned 404.

[Service evidence](research-evidence/document-workspace-live-2026-09-20.json)
records durable write receipt, reader convergence, denied reader mutation and
reconnection. A cold test stopped only the isolated gateway and deleted only
the test document's Redis cache entry; content recovered from durable storage.
This does not mean resettable mock draft metadata survives a BFF restart.

Final browser review probe passed assignment as Farah, approval as Jonas,
reload persistence, no reviewer request controls and no owner approval control.
Real before/after tree drag operations also passed. Recovery probe failed with
`Fault injection did not hold a CRDT write`; that is a failed harness setup,
not proof that recovery works or that product recovery failed. Image probe
reached `Upload failed: HTTP 500`; investigate the blob/storage write path.
The UI worker hit its usage limit before completing its final evidence commit;
the coordinator preserved the code and these qualifications in this checkpoint.

## Procedures for the next session

1. Read this document, root CLAUDE.md, owning-repo instructions, then inspect
   `git status` in every repo. Respect the accelerator no-push restriction and
   unrelated WorkGraph/chat/release edits. Inspect full SHA pins, not version
   strings alone. Reconfirm current listeners before starting another watcher.
2. Read [build/run guide](document-workspace-build.md). From the root:

   ```sh
   node scripts/document-workspace.mjs build-plan
   node scripts/document-workspace.mjs build
   node scripts/document-workspace.mjs check
   node scripts/document-workspace.mjs up
   node scripts/document-workspace.mjs middleware
   # Separate terminal:
   node scripts/document-workspace.mjs portal
   ```

   `build` archives exact committed sources; it must not copy sibling dirty
   files or host node_modules into Docker. Missing repositories can be fetched
   into an isolated bare cache. The root launcher Compose project is
   `assessment-document-workspace`. `down` retains volumes; never add `-v` as a
   routine reset. No cloud credentials are needed for this local mock setup.
3. Ports: portal5183, BFF3001, document gateway18081, platform13002. The independent
   reference UI15174/gateway18080/platform13001 must not be restarted. At this
   checkpoint all six isolated containers were healthy, but still running the
   older local tags (`document-workspace`/`codex-*`), not the newly built
   source-SHA tags. Switching them with `up` and rerunning acceptance remains.
4. Private generated settings live at `.scratch/document-workspace/settings.json`
   with restrictive permissions. Do not print, commit or copy them into docs.
   Source publication additionally requires `ASSESSMENT_SOURCE_URL` and
   `ASSESSMENT_SOURCE_SECRET`. Source ownership can be configured through
   `DOCUMENT_SOURCE_OWNER_SUB`; do not give first reader ownership.
5. Open `http://localhost:5183/assessment/workspace?doc=page%3A100002`.
   Use isolated browser contexts for u-farah (editor/lead) and u-jonas (reader/
   assigned reviewer), and u-operator for certification. Ports on the same host
   share cookies: do not change the user's existing browser session to test.
6. Check `lsof -nP -iTCP:3001 -sTCP:LISTEN` before restarting BFF. A duplicate
   old tsx watcher previously reclaimed 3001 and caused intermittent private
   callback503/socket401. At checkpoint launcher logs are
   `/tmp/document-workspace-middleware.log` and `/tmp/canvas-portal-dev.log`.
   An isolated wire-capture watcher may still exist on3011; stop only an
   identified task-owned process, never an unrelated tmux session.
7. Git dependency updates use full 40-character SHAs. Verify installed import
   identity and dist exports, not sibling source. The helper
   `scripts/install-committed-library.mjs` archives/packs committed dist and only
   accepts an unchanged dependency graph; dependency changes need normal npm
   resolution. Restart Vite with `--force` after adoption. Do not rebuild shared
   UI from a dirty checkout and accidentally ship concurrent work.
8. Run targeted tests for changes, then relevant full gates. Commands:

   ```sh
   npm --prefix middleware test -- --maxWorkers=2
   npm --prefix middleware run typecheck
   npm --prefix portal test
   npm --prefix portal run build
   bash scripts/validate-mock-floor.sh --quick
   bash scripts/validate-component-discipline.sh --quick
   bash scripts/validate-nav-parity.sh --quick
   node --test scripts/docker/tests/document-workspace-build.test.mjs
   node scripts/research/document-workspace-live.cjs
   node scripts/research/team-certification-audit.cjs
   ```

   The live document probe creates a fresh local draft; it is not read-only.
   Certification probe is read-only. Recapture wires following `docs/mock-floor.md`
   after the final handler changes, using an isolated mock BFF. Durable external
   document writes are deliberately excluded from mock write replay because an
   Aurora mock reset cannot undo gateway/platform/source state. Keep the explicit
   boundary list narrow; do not raise the ratchet budget or fake a mock success.

## Prioritized roadmap and acceptance criteria

1. **Fix image upload500.** Reproduce the browser upload; inspect gateway error
   and storage path/volume permissions. Fix the owning repo/container contract,
   rebuild/pin only its committed source, and repeat upload, authenticated image
   display, reload and second-reader checks. Do not replace it with a local UI
   workaround. Persist a nontrivial table and compare cells after reload too.
2. **Prove recovery.** Correct the WebSocket interception to the actual protocol,
   hold a real outbound update/receipt, verify no false Saved status, navigate
   away/back, and explicitly recover/download/discard. Check restored server
   content is never overwritten automatically. Keep failed harness results honest.
3. **Unblock accelerator tests.** The attempted documented command failed:
   `zsh:1: command not found: uv`. Its CLAUDE.md section "When a command fails"
   says **"STOP. Do not try alternative paths, different Python interpreters,
   or creative workarounds."** The prior question about restoring/installing uv
   was unanswered. Follow the owning environment repair process; no alternate
   interpreter was used. Run bridge/converter/source tests once resolved.
   Do not push to this repository.
4. **Source acceptance.** Configure an authorized test source; exercise image and
   table import, reviewed publish, remote conflict409, explicit pull reconciliation,
   protected attachments, draft new-page retry and remote ordering. Verify no
   duplicate page on uncertain retry and no silent overwrite. No real Confluence
   write has been performed in this implementation pass.
5. **Coherent deployment smoke.** Start all source-tagged images, verify startup
   health/schema and private epoch callback, then rerun writes/reconnect/cold
   recovery/locked mutation checks. Do not claim production-ready based only on
   separate unit tests. AWS deployment/migrations require a separate authorized
   step; CDK remains opt-in and single writer with stop-before-start replacement.
6. **Finish UX/audit matrix.** Document narrow-screen/editor/sidebar experience,
   permission/error/empty states, inside tree drops and keyboard interactions.
   Section review items need real anchors before controls are exposed. Update
   only journey evidence actually re-exercised; stale historical digests are not
   fixed by copying a fresh hash into old observations.
7. **Release hygiene.** Coordinate the shared UI minor release with its current
   owner; examples frontend currently has final UI/RT pin changes alongside
   unrelated dirty messaging/WorkGraph edits. Commit only document-owned pin
   hunks after checking their dependency graph and build. Keep every consumer
   tied to actual built commits. Follow the user's no-accelerator-push instruction.

## Known limits and decisions not to erase

- No live Aurora schema migration, AWS deployment, Confluence publication or
  production availability claim. Single-writer durable storage is not active-
  active CRDT replication or zero-downtime replacement.
- Local source metadata under mock Aurora resets independently of durable binary
  documents. Do not present old test draft IDs as permanent user bookmarks.
- Unconfigured source actions are unavailable, not fabricated successful writes.
- UI2.331.3 includes the needed exports despite imperfect release numbering.
  Another session's dirty2.332.0 does not authorize this session to take ownership.
- Large portal chunks still produce Vite size warnings; the build passes.
- Earlier auth audit/checkpoint is in [September19 handoff](handoff-2026-09-19.md).
  It is separate from the document feature; this file does not silently recertify
  its dependency audit or every unrelated application route.
