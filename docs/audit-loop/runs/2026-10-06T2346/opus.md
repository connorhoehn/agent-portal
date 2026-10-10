# Escalation review 2026-10-06

The escalation question is already answered by an existing test. A real-router contract shows that an orgiq session gets `AUTHZ_CHANNEL_DENIED` on every cursor verb against an assessment document (subscribe, get and update), and that the reader receives nothing (`middleware/src/lib/__tests__/realtime-gateway-cursor.test.ts:109-123`). There are no high or medium findings. The real gaps are one missing revocation test and one upstream cursor option.

## Verified findings (ranked)

| # | file:line | verdict | fix location | sketch |
|---|---|---|---|---|
| 1 | `middleware/src/lib/gateway-cursor.ts:34-56` | **Real, med (design).** The library's `CursorService` copies client `metadata` straight into the broadcast (`dist/cursor/CursorService.js:174-178`), so by default any client can spoof another person's name and colour. The local wrapper fixes this by patching `service.handleAction` at runtime. That is correct today but will break silently on a library upgrade. realtime-examples never rebuilds identity on the server (`realtime-examples/src/server.ts:1266-1276`), so the reference app has the spoofing hole too. | realtime-modules | Add `cursor({ resolveIdentity?: (ctx) => { displayName, userInitials, userColor } \| null, metadataAllowlist?: string[] })`. The service would build `metadata` from the router's `userContext` and drop any client fields not on the allowlist. Once that ships, delete the patch and keep `cursorColor`/`cursorInitials` as the resolver. |
| 2 | `middleware/src/lib/__tests__/realtime-gateway-cursor.test.ts:81-136` | **Real, low (coverage).** The cross-tenant and malformed-frame cases pass. There is no cursor case for an epoch bump or loss of a grant while a subscription is open. The router re-checks authority on every fan-out (`realtime-gateway.ts:893-901`, `authorizeChannel` at `:331`), so behaviour is probably correct, but the cursor path itself is unproven. | portal-repo test (middleware) | Copy the revocation pattern from `realtime-gateway-page-huddles.test.ts`. Bump Farah's epoch, send an update from Jonas, and assert Farah receives no `cursor` frame and a fresh `get` answers `AUTHZ_CHANNEL_DENIED`. Authority stays fresh on every check, with no cached allow. |
| 3 | `docs/audit-loop/realtime-parity.md:22,47,88,102` | **Real, low.** All four lines still say `cursor()` is "not mounted". The mount is at `realtime-gateway.ts:958-960` and the canvas uses it. | docs | Assessment Cursors → ✅ (`CanvasDocumentPane.tsx`). Gap 4 should name rooms, recordings and knock only. Rows 88 and 102 become "server done; client in orgiq, social and pipelines". |
| 4 | `middleware/src/lib/social-notify.ts:365-370` | **Real, low, legitimately local.** The library's `parseDmLobby` needs the caller to pass the prefix (`dist/call/lobbyChannel.d.ts:60-62`). The local function only works out the tenant, then hands member parsing to the library's `dmLobbyMembers` (`:26`). | realtime-modules (optional) | `parseDmLobby(name, { prefix: 'any' })` returning `prefix`. Not urgent. |
| 5 | `portal/src/components/canary/edges/WeightedEdge.tsx:57-71` | **Real, low, exempted** (queue row 221). The installed `AnimatedEdge` already scales width by `volume` and shows a midpoint pill (`ui-components/dist/pipelines.d.ts:222-229`), but it is tied to pipeline `state`/`payload`. | ui-components | Move a generic `WeightedEdge` into `/graph` with props `{ weight: number; weightRange?: [min, max]; label?: ReactNode; labelOffsetY?: number }`, and have `AnimatedEdge` reuse it. |
| 6 | `portal/src/components/canary/setup/VersionPickerStep.tsx:63,70` | **Real, low, exempted** (queue row 53). Confirmed there is no standalone `Radio` export in 2.423.0. | ui-components | `<Radio checked name value onChange tone?>`, plus a `RadioGroup` option whose `label` accepts `ReactNode` with an optional accent stripe. That covers the rich version rows. |
| 7 | `portal/src/components/ingest/Thumbnail.tsx:42,57` | **Real, low, exempted** (queue row 222). Confirmed there is no `Thumbnail` export in 2.423.0. | ui-components | `<Thumbnail src alt width aspect="16/10" state="ready\|pending\|failed" fallback?>`. It would also serve the attachment thumbnails that `useAttachmentSrc` feeds in Social chat. |
| 8 | `portal/src/components/decks/ShareToSocialAction.tsx:127-130` | **Real, trivial.** A `<p>` sits inside `<Prose>`. `Prose` exists to style children like this, so it is borderline allowed. | portal | Drop the `<p>` and let `Prose` wrap the text directly. Cosmetic only. |

## Rejected findings
- **"`authorizeChannel: () => true` bypasses authority"** (the ESCALATE reason): rejected. That value is the library default (`dist/cursor/types.d.ts`: "Default: allow all… Runs in addition to `attachRealtime({ authorize })` — both must pass"). The hook is synchronous `(clientId, channel) => boolean`, so it could not run the async fresh-directory check anyway. Authority sits correctly in the router's async `authorize` (`realtime-gateway.ts:331`), with `cursor` registered as an ephemeral read-authority service (`tenant-channels.ts:93`). The cross-tenant test proves the refusal. Removing the redundant argument would be clearer, but nothing is broken.
- **"realtime-examples leaves identity to the client, so we diverge"**: this is not a defect on our side. The reference app is the one with the gap, which is why finding 1 points upstream rather than at the portal.
- **The 12 `EventSource` sites**: not re-flagged. They are non-gateway feeds, and the Sonnet triage holds.

## Library work to batch into one release
**realtime-modules 0.114** (one release):
1. `cursor({ resolveIdentity, metadataAllowlist })`, with the server stamping identity. Fixes metadata spoofing for every consumer, realtime-examples included.
2. `parseDmLobby(name, { prefix: 'any' })` returning the discovered prefix.

**ui-components 2.424** (one release, closes queue rows 53, 221 and 222):
1. `Radio`, plus a `RadioGroup` option with a `ReactNode` label.
2. `Thumbnail` with aspect ratio and pending/failed states.
3. A generic `WeightedEdge` in `/graph`, shared with `AnimatedEdge`.

**Portal and repo, now, no release needed:** the cursor revocation test (finding 2), the matrix update (finding 3) and the `Prose` cleanup (finding 8).

The Gmail, Google Calendar and Google Drive connectors need authorizing in your claude.ai connector settings before this session can use them.
