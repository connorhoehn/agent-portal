# Document workspace implementation

> Checkpoint: see [the complete handoff](document-workspace-handoff-2026-09-20.md)
> for the final September 20 state, procedures, commits, blockers and roadmap.
> It supersedes the in-progress counts and remaining-work notes below.

Active implementation of the complete September 20 reuse plan. This file records
what is verified and what still needs acceptance; it is not a cloud deployment
report. The reference remains the accelerator workspace UX and the existing
realtime-examples paper canvas, not a replacement editor.

## Parallel ownership

| Workstream | Owner | Output |
| --- | --- | --- |
| Shared UI and portal | shared_document_ui | Shared header/images/history/tree contracts; actual canvas, local drafts, source review, contextual sidebar and durable threads |
| Realtime and source bridge | realtime_contracts | Scoped grants, durable receipts, seed/projection, authenticated uploads, accelerator source adapter and idempotent publication |
| Workflow and deployment | document_workflows | Central ownership/reviews/lifecycle, locked-content enforcement, binary history operations, reusable Docker/CDK integration |
| BFF and assembled validation | root | Canonical mapping, revocable identity delegation, trusted seed, reviewed publication routes, releases, running-stack evidence |

## Implemented contracts

The BFF maps each assessment source ID to one opaque document UUID in Aurora.
Its original source hash stays immutable; acknowledged publication advances a
separate comparison base. Concurrent first opens converge. Mock mappings are
registered and deterministic; local mock draft metadata remains resettable.
Production drafts insert node, document and verified-creator mapping in one
transaction. Apply the updated assessment SQL schema through the normal migration
process before enabling this against Aurora; no live migration was run here.

Migration uses the same actual canvas schema as the shared editor. The BFF sends
one seed-only grant and waits for durable gateway acknowledgement before marking
migration ready. Refresh never reconstructs an existing document. Browser grants
contain read/comment and, when permitted, edit; they never contain seed/manage.
Old Markdown writes/restores are rejected after migration.

Identity comes from the session subject, tenant, role and current epoch. The
private epoch callback requires its shared credential even in development and
fails closed if authoritative identity storage is unavailable. Gateway and
platform verify the current epoch. The platform's document-grant verifier runs
before its general Cognito gate, without opening unrelated endpoints.

The gateway asks the platform's existing lifecycle policy before each content
mutation. Approved/finalized content refuses edits, restores and uploads; reads
continue. An operation already in flight can cross a concurrent lifecycle change:
this is per-operation authorization, not an atomic cross-store write fence.

Source preview/publication derives Markdown from an acknowledged binary version,
not a browser body. Publish requires the reviewed projection hash and source
revision and rejects concurrent changes. Source attachments use a view-gated BFF
proxy; stable document upload URLs never contain tokens. Source integration uses
the accelerator's existing converter and Confluence handlers. Missing source
configuration reports unavailable rather than simulating remote publication.

## Running locally

The owned Compose project is `assessment-document-workspace`, reusing
`realtime-examples/examples/middleware-foundation`. Its volumes are retained.
It runs the gateway on loopback 18081 and platform API on loopback 13002. The
reference example on 15174 is independent and was not restarted.

```sh
node scripts/document-workspace.mjs check
node scripts/document-workspace.mjs up
node scripts/document-workspace.mjs middleware
# In another terminal:
node scripts/document-workspace.mjs portal
```

`build` now builds all five owning service images from pinned committed Git
archives and pulls the pinned Redis digest. It can fetch missing repositories into
an isolated cache. See [the build guide](document-workspace-build.md) and the
[successful image provenance](research-evidence/document-workspace-images-2026-09-20.json). Private local keys are generated under
`.scratch/document-workspace/settings.json` with restrictive permissions. Never
commit that file. Stop stale BFF watchers before starting the configured one;
an old watcher competing for 3001 caused intermittent missing configuration.

Open `http://localhost:5183/assessment/workspace?doc=page%3A100002`.
A lead-assessor can create and edit a local draft. A reader sees the same binary
without write controls. Source publication additionally needs
`ASSESSMENT_SOURCE_URL` and `ASSESSMENT_SOURCE_SECRET`; absence does not make a
local edit a remote publish. Source ownership is explicit via verified local
creator or optional `DOCUMENT_SOURCE_OWNER_SUB`, never the first reader.

## Evidence collected

- Actual workspace browser: New page modal → shared TipTap edit → server Saved
  receipt → reload preserved text → second reader saw it with no edit controls.
- Root comment and threaded reply persisted with the correct parent; document
  reaction persisted after reload. Zero page JavaScript errors in these runs.
- Two-client transport proof: durable update receipt, reader convergence,
  unauthorized reader write rejected, reconnect content preserved.
- Gateway stop/start plus deletion of only the test document's Redis cache entry
  recovered its edited content from durable storage. A fresh scoped reader grant
  was used after BFF hot reload; this is a binary storage proof, not a claim that
  resettable mock draft metadata survives a mock-process reset.
- Real lifecycle flow: explicit owner, review assignment/approval, already-open
  editor refused, restore refused, pending HTTP upload refused, REST section
  write refused, snapshot still readable, finalization cannot be reopened.
- Evidence: [running-service results](research-evidence/document-workspace-live-2026-09-20.json).
  Reproducible draft probe: `node scripts/research/document-workspace-live.cjs`.
- Local gateway, platform, catalog, Redis, MQ and durable store are healthy.
  Catalog clean Docker build required installing the UI source's locked Linux
  dependencies; relying on host node_modules did not build reproducibly.
- Shared UI: 8,512 passed, 2 skipped; source/demo typechecks and library build.
  Portal: 928 passed before the final history/tree/source-action additions.
  Full middleware run: 4,358 passed, 8 failed; identified failures were an
  import cycle, newly added route snapshots, draft-row fields and a pre-existing
  promotion test ordering assumption. Fixes pass targeted reruns; final route
  capture must follow the last API changes. Do not call the whole suite green yet.
- Opt-in CDK construct/consumer synth tests passed; no AWS apply occurred.

## Remaining acceptance / explicit limits

Finish latest shared release adoption, binary history/reviews and source-image
publication, run final portal/middleware/type and wire gates, inspect the team
certification page, and refresh affected browser audit evidence. Existing journey
and branding validators currently report stale source digests; old screenshots
are not evidence for this implementation.

The accelerator Python tests could not start: `zsh:1: command not found: uv`.
Its CLAUDE.md requires stopping rather than trying other interpreters. The user
has been asked to restore the standard runtime or authorize installing uv; no
alternate interpreter was used. Source bridge tests remain unverified until that
is resolved. No real Confluence write was performed.

Deployment is single writer with stop-before-start replacement. This work does
not claim active-active CRDT durability, zero-downtime replacement, live Aurora
migration, or a deployed AWS environment.
