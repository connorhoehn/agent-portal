# Work / Social follow-up verification — 2026-11-02

Continuation of [the current TODO](work-social-ui-todo.md). Scoped Search opens
one Work collection inside the initiative, offers explicit record-type
navigation, and preserves scope when choosing People or All results. The All
view is one ranked collection. Earlier implementation and evidence are in
[the scoped Search report](scoped-search-2026-11-02.md).

This follow-up's app implementation is committed and pushed as `8ff773f4`.

## Shared audit ownership and package

ui-components source commits `7328ed38` (shared source/transcript audit) and
`1562c6cf` (prose and toolbar alignment), releases `4d66d31d` / `a33f309f`, final
package **2.499.7-audit.0**. Packaging source `2c9136b2` and release `081fc21a`
are pushed on isolated branches; [the source-only draft PR](https://github.com/connorhoehnslalom/ui-components/pull/1)
keeps concurrent composer work separate. The portal installs the tracked tarball; its installed
files match the archive. Vite's optimized cache was moved aside and the Tilt
portal restarted. The rendered audit sees the new composer marker.

The shared skill now owns `scripts/source-audit.cjs`: AST composition candidates,
CSS private-selector candidates, and lockfile/archive/installed-byte verification.
The app's `scripts/audit-ui-inheritance.cjs` retains required migrations, density
entry points, source roots and ratchet policy. Before/after JSON output on the
same source tree is identical. Shared source tests (3), consumer source tests
(2), and shared mutation tests pass. Component discipline passes with no raised
budget. Final isolated library gate: 1,028 files, 11,303 tests passed, 2 skipped;
lint and build pass. All 339 runtime distribution files match 2.499.6 exactly;
the prerelease adds the audit resources and packaging metadata.

The archive includes the entire skill. Source, DOM and journey adapters prefer
the installed copy; `UI_DOM_AUDIT_SKILL` is an explicit development override.
Clean-consumer tests verify pinned-copy precedence and fail clearly for missing
resources. No sibling repository or personal skill install is required after
installing the app's pinned package. The actual npm pack manifest is tested.

The transcript's text edge is intentionally 36px: 8px hover wrapper, 20px avatar,
8px gap. Actions remain 8px inside the wrapper. The shared profile checks those
parts separately; ordinary neighboring alignment still fails when mutated.
Docked composer tools use 8px; compact tools use 6px. Valid and broken fixtures
cover these profiles. Final joined transcript deep audit: **33 cases, 0 findings,
0 unclassified composer policies**, dark/light, 900/1440px. The previously
unstable focus/menu probes complete. No spacing tolerance was increased.

The final runbook walk exposed a genuine 18px notice indent and 13px toolbar
labels. Shared AccessNotice now uses an 8px marker plus 8px gap; medium Toolbar
inherits the standard 14px body scale. MarkdownView's intentional 4px inline-code
background inset has an exact padding/margin contract and mutation tests;
neighboring prose still receives the normal grid checks. Catalog group labels
use the same heading/count treatment as the other rails.

Runbook History/Runs use h2 section headings. Runs shows its run table before the
procedure. Brief assembly IDs and checksums render as safe inline code inside
the document. The 18 focused presentation/formatting/profile tests pass; the
final Design provider/route rerun passes 25 tests. Portal typecheck passes.

## Inbox actions and design identity

Inbox consult answers now use the existing DispatchAgentRun capability; queue
review actions use ManageDevbox. Distinct unavailable reasons explain which
action a role can take. Backend permission policy is unchanged. Five prompt
presentation tests and 95 existing backend authorization/lab tests pass.

Design posts and sign-offs now carry canonical author/signer IDs from the signed
session. Request-body IDs/photos cannot impersonate another author. Known fixture
identities are explicitly backfilled; grouping, replacement and portrait lookup
use IDs. Renaming one person does not create another approval; namesakes remain
separate. A historical name-only approval cannot establish a distinct signer
for quorum; a historical rejection still blocks. The 25 middleware and 8 portal
design tests pass, including spoofing, renamed identities and namesakes.

`design_posts.author_id` and `avatar_url` are additive schema columns. The
existing sign-off schema already keys on `people.id`. **The Design provider is
still mock-first; its Aurora implementation is not wired.** No live historical
identity was inferred by name and no cloud migration is claimed. Unlinked
account identities (`user:<id>`) need an explicit durable sign-off representation
when that provider is implemented; the SQL table currently requires a person ID.

## Gallery acceptance

Seven Chromium cases pass: six fixture matrix cases (1/2/6/12 participants,
light/dark, 1440/900/540px) and a real two-client local SFU call with synthetic
camera/microphone devices. Each cloned user receives audio samples and decoded
video frames. The test verifies 416px maximum tile widths and 16:9 ratio, visible
controls, People/Conversation switching, camera-off retained media/audio,
camera-on video recovery, and returning to a bounded single-person gallery.
The passing run archives its owned room and deletes its clones.

The first transport attempt timed out on an obsolete test selector, after media
was already flowing. The corrected test uses the actual Social control marker
and a bounded action timeout. Its leftover room was archived in the local test
DynamoDB with conditions matching the exact room ID, owner clone, slug and name;
no shared reset was used. The passing test uses normal owner API cleanup.
Screen-share presentation, WAN reconnects and real hardware permissions remain
outside this gallery acceptance.

## Local portrait verification

All 80 locally served JPEGs match the manifest's SHA-256 hashes. The reviewed
ID-only data migration targets 59 graph people and 12 unlinked accounts. It
changes only missing portraits or the exact known legacy PNG/SVG path for that
ID. It preserves custom images, linked accounts, unknown IDs and concurrent
custom-photo changes. A disposable PostgreSQL 16 test proves selection,
preservation and idempotence. `prepare-backfill.mjs --check` checks generation;
the existing migration framework's 25 tests pass using `.venv-synth/bin/python`.

The user explicitly directed this work to remain local and not use AWS. Earlier
read-only identity/host checks did not verify a deployment and made no AWS
changes. No further AWS checks, credential requests or deployment are part of
this task. The prepared migration remains an unapplied, locally tested artifact.

Assessment contributors remain presentation JSON with no canonical IDs. They
are deliberately excluded from the ID-only migration; identify the actual
contributors before changing their photographs. Demo session photos
come from the application and do not require an app_users row.

## Bundle profile

The initial script is **4,485,082 bytes** (gzip **1,345,718 bytes**) in the
production build profiled by `scripts/profile-portal-bundle.mjs`. The script
writes to a disposable .scratch directory and preserves the warning threshold.
The largest rendered module contributions before minification include React DOM
506 KB, xterm 415 KB, ProseMirror view 248 KB, the UI graph entry 245 KB, Tiptap
core 243 KB, Yjs 219 KB, RTCallService 210 KB, DocumentEditorPage 206 KB and
MediaPipe 190 KB. These are module attribution sizes, not separate network chunks.

Next split candidates: load terminal code with terminal views; graph code with
Connections/graph views; document editing with document routes; camera effects
only when chosen. Confirm each boundary by profiling the resulting static entry
closure and testing the relevant interaction. This report identifies candidates;
it does not claim those imports have already been split.

## Evidence

Final route measurements all record source digest
`555e35b5595c64f797ac358f01fa32e518302c410e3a73613b7a7d0711af470e`:

- Rail parity: 19 route contracts pass.
- Layout: 147 inventoried routes; Work 84, Social 14, Pipelines 16 and Access 15
  pass. Assessment has 3 missing-breadcrumb violations across its 18 routes.
- Typography: all 147 routes report zero new offenders. The additional granted
  Communication probe reports an existing 11px Pinned marker; it is not a claim
  that every rendered state is free of typography debt.
- Contracts contain 159 layout and 166 type entries including observed states
  and primary rails. All three measurement digests match the current local tree;
  no mixed/stale digest was used for final sealing.

Local evidence is under `.scratch/work-social-followup-2026-11-02/`:
`source-audit-parity.json`, `installed-audit-final-package.log`, `transcript-final/`,
`gallery-live-final/`, `avatar-sql-test.log`, `local-avatar-hashes.json`,
`hosted-avatar-hashes.json`, `bundle/`, `ui7-runtime-parity.json`,
`ui7-isolated-gate.log`, `runbook-deep-ui6/`, and the journey measurement/walk directories.
Failed attempts remain alongside final runs. Screenshots were inspected for the
live gallery. The measurement inventory also exposes separate Assessment
breadcrumb debt; no unrelated page changes or baseline relaxations were made.

Rendered checks use the shared local working tree, including the independently
owned Assessment/huddle edits listed in the handoff. Their measured source
digest is recorded in the contracts; these are not clean-checkout measurements
of commit `8ff773f4` alone. Recheck freshness after integrating or removing those
edits. The separate library packaging gate used an isolated clean checkout.

The document deep audit passes 25 cases with zero findings and zero unclassified
composer policies (both themes, 900/1440px). Its UI runtime is byte-identical to
the final packaging release. All eleven runbook walks pass after updating two
stale expectations to open Files and provenance and use the File changes heading.

Search walks wait for the requested record types after a filter change before
counting collections. Waiting only for the new group label could sample the
intermediate loading frame; the corrected check still requires exactly one
collection, retains initiative scope, and proves All contains both people and
work. Palette checks likewise wait for remote record options to settle.

The final 26 walkthroughs pass and are individually sealed against the fresh
measurements: Search, Decisions and Sprints for each of the five Work roles,
plus all eleven runbook journeys. See `final-search-settled.log`,
`final-decisions.log`, `final-sprints.log`, `final-runbooks.log` and
`final-seals.log` in the evidence directory. Coverage generation is current.

The final quick Work validator retains two failures: 66 of 125 historical logs
need genuine re-walks after their contract/spec changes, and `orgiq:admin` has
no mapped walkthrough. Every recorded Work verdict is passing, no Work log has
a gating DOM finding, and all map depth and coverage-floor checks pass. This is
targeted verification with documented remaining coverage debt, not certification
of the whole historical catalog.
