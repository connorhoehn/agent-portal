# Canonical DM page-reference acceptance — 2026-10-04

The subsequent [work/document record](work-document-association-acceptance.md) carries the final combined-source counts and capture. This earlier DM record preserves its own phase evidence.

Direct messages can now attach the current initiative or work item. The sender's page, conversation destination and acknowledged huddle share remain independent. This completes the DM attachment slice from the [October 3 checkpoint](../2026-10-03/session-resume-acceptance.md); the full integration remains in progress.

## Resulting behavior

- Chat-to-person shows a removable current-page chip. Submission captures the recipient and descriptor before awaiting DM creation. Removing the chip sends plain text and leaves the huddle share intact. Unsupported pages explain that no page can be attached.
- The BFF validates current source identity, Social PostMessage authority, canonical two-person DM membership, an explicit OrgIQ grant and canonical resource existence before delegating persistence to the shared chat service. Stored metadata and live/history chat frames contain only `{kind,id}`. Client titles, URLs, arbitrary kinds and malformed IDs refuse before persistence. Non-DM namespaces retain their original admission rules, including raw huddle write denial.
- `GET /api/social/dms/page-reference` resolves a stored message under the reader's current Social and OrgIQ authority. It enforces message visibility and history floors, rechecks authorization and message identity after slow resource reads, and returns `Cache-Control: no-store`. Missing/deleted resources or missing OrgIQ grants return an opaque unavailable reference; directory/policy failures fail closed.
- The reader clears previously resolved metadata when refreshing and fences delayed responses against identity, conversation and message changes. Open revalidates current access. A Social workspace reader goes through explicit OrgIQ workspace/role selection; the destination is canonicalized before use.
- Real-browser checks verify live peer delivery, reload recovery, the exact work-item destination, one persistent huddle/media instance during navigation, independent shared-page pins, plain-text sends, and retained drafts after delayed receipts. Generic DM sends remain non-idempotent; unknown acknowledgements retain the draft and advise checking history before retrying.
- Concurrent huddle restoration now cancels only a superseded membership-generation reconciliation. Its stale writes remain fenced, HTTP reads/sends retain their conflict response, and provider failures still surface. A delayed reconciliation test verifies that a departed participant stays inactive and the latest roster wins. The accepted browser gateway log contains no feature-reconciliation failure.

## Package delivery

The portal pins ui-components **2.408.0** at full SHA [`69d0283d1e6e0cf6d9a3684eaa78dcbf465b3901`](https://github.com/connorhoehnslalom/ui-components/commit/69d0283d1e6e0cf6d9a3684eaa78dcbf465b3901), pushed only on `fix/chat-reference-renderer`. The scoped source change forwards the existing `ChatPanel.renderMessageReferences` option through `WrappedChatPanel`. The owning sibling main remains clean at `39b56ee6e4d5bced1639ea6040067d91a2226270`; it was not merged, tagged or released to a registry.

The UI full gate passes **946 files / 10,443 tests**, with two skipped tests, both source/demo typechecks and the build. A normal packed-package install passes TypeScript and runtime rendering checks. Its tarball shasum is `bdd10d101229f47986b2309d59cbdf531b777e9b`. The package's consumer handoff explains the additive option. An existing doc-editor packaging expectation was corrected to match the unchanged baseline's static imports; the [before/after import proof](ui-packaging-baseline.json) confirms this renderer adds no peer requirements.

Both BFF and portal retain realtime-modules **0.100.3** at `5aa384065b2b53e8e662c88a8a2fe1d87ed847a7`. Normal consumer installation exposed the portal's undeclared `@tiptap/suggestion` peer; the portal now declares the installed mention extension's exact **3.31.3** peer. No installed library files were patched. Docker preparation exports committed artifacts from the exact locked SHAs.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| UI full gate | 10,443 passed, 2 skipped; typechecks/build passed | [Tests](ui-tests.log), [typechecks](ui-lint.log), [build](ui-build.log) |
| Packed UI consumer | TypeScript and actual packed renderer passed | [Types](ui-package-types.log), [runtime](ui-package-runtime.log) |
| Portal | 1,316 tests passed; typecheck and production build passed | [Tests](portal-tests.log), [typecheck](portal-typecheck.log), [build](portal-build.log) |
| Backend acceptance | 18 suites / 208 tests passed, 2 skipped | [Raw run](backend-acceptance.log) |
| Browser | 40 distinct checks passed: 14 real BFF contracts and 26 component fixtures | [Raw run](browser-acceptance.log) |
| Floor and source freshness | All quick judge checks passed; budgets unchanged | [Judge](mock-floor.log), [capture](wire-capture.log) |
| Host architecture checks | Component discipline, navigation parity and route coverage passed | [Components](component-discipline.log), [navigation](nav-parity.log), [routes](route-coverage.log) |
| Gateway production image | Build passed; committed realtime 0.100.3 and new descriptor guard present | [Build](gateway-build.log), [artifact](gateway-artifact.json) |

The backend run includes actual Redis Lua and four durable Redis/Dynamo huddle integration checks. The two skips are the separately opted-in storage restart and the legacy Social test requiring unprefixed `chat-*` tables. The browser's canonical DM creation, signed sessions, WebSocket delivery and prefixed Dynamo history are real. Media-session receipts remain substituted; this is not WebRTC acceptance.

The fresh isolated capture on port 3062 enumerates **616 routes**, represents **333 GET routes** (266 captured responses, explicit reasons for the remainder), and **283 writes** (109 responses captured). Both GET and write snapshots match handler SHA `a02f9d2dcc1739d24ca54e23a9aef4cfa629d7486f9791ec66bcafbed166631e`. The new DM reference GET needs a persisted message and deliberately refuses an uncorrelated sweep request; its real HTTP/WS test and browser checks cover the successful read.

The [manifest](dm-reference-manifest.json) records source/evidence digests, exact package pins, prepared library artifacts and image identities. The rebuilt gateway image is `sha256:1732170b1feab5f53eb6228e6e4553f8a25027db4665c7b0dfc7fcaa4494524e`. The running soak container retains its earlier image; no new container capacity/restart acceptance is claimed. October 3 continuity and authority-aware load results remain historical evidence for their recorded sources.

## Remaining work and runtime

Persisted work/document associations, actual SFU/audio/video, provisioned directory/Aurora capacity, tenant cloud acceptance, distributed gateway routing and final Work rail/layout walkthroughs remain open. Ring recipients and notification replay still need equivalent per-recipient current-authority checks. Membership observers do not establish external or distributed invalidation. Keep the single-gateway deployment safeguard.

The final application remains available at **http://localhost:5261**, backed by BFF 3061, Redis 16479 and DynamoDB Local 18061. Capture BFF 3062 and Chrome CDP 19361 remain isolated. Verify current process ownership before restarting; historical PID/session IDs are not durable. The active Docker context is Colima; the old temporary Docker socket path is absent. No root commit, main merge, cloud deployment or registry release was performed; unrelated work remains preserved.
