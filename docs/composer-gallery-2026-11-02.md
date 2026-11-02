# Composer collapse and hangout gallery — 2026-11-02

The initiative composer has an explicit Collapse composer button beside its context chip. It folds to one row with the mode, destination and a retained-draft indicator. The editor and files stay mounted; Expand composer and external focus requests restore the caret. Active prompt decks retain their own disclosure controls. The call dock remains visible when the message editor folds.

The Social hangout Call view uses bounded 16:9 gallery tiles (maximum 416px wide), including when only one person is present. People and Conversation occupy a right sidebar. Close and Escape restore focus to the corresponding trigger. Below 780px of available content width the sidebar overlays the gallery instead of squeezing its tiles. Call controls remain below the independently scrolling gallery. The old Conversation URL still opens the call's conversation; there is no second full-page conversation tab.

The roster comes from the live call/meeting and the transcript remains HuddleChatBody. No seeded participant count or mock media was added to the product. Camera-off transitions now retain the same media element so they do not interrupt remote audio.

## Shared ownership and release

ui-components 2.497.0 owns ContextComposer/ConversationComposer folding and the CallDock/CallTileRow gallery. Stories include CollapsibleDraft, DedicatedStage and SoloGallery. The portal installs the packed library, clears the optimized dependency cache and restarts the Tilt portal. The HuddleChat pane-owner registration contract is included as the RoomPane sidebar's dependency; unrelated worktree changes remain separate.

## Validation

- Library: 1,028 test files, 11,293 tests passed, 2 skipped; lint and production build passed.
- Portal: typecheck passed; 10 isolated Chromium cases passed. Composer cases use a real cloned Rachel session on the requested Work tab in light/dark at 1440/900px. Gallery cases render the actual HangoutCallView and installed CallDock with 1/2/6/12 participants in light/dark at 1440/900/540px; assert bounds, 16:9 ratio, control visibility, sidebar navigation/closing and stable media DOM.
- UI audit: Work 4 resting cases and 18 deep cases, zero findings; Social Call 4 resting cases, zero findings; zero unclassified composer policies. Social route audit was outside a joined call; active gallery geometry is covered by the local component fixture.
- Portable audit rules call.gallery.tile-width and composer.folded.height have passing/broken mutation fixtures. Audit self-tests pass.
- Evidence: .scratch/composer-gallery-2026-11-02 and portal/test-results.

## Remaining validation / debt

- A live multi-client native media call was not started for this UI change. Network reconnection, device permissions and breakout delivery retain their existing integration tests; the new acceptance suite verifies layout and mounted media, not transport delivery.
- Screen shares still use the existing call tile/pop-out behavior. A separate large shared-screen presentation alongside the gallery remains a follow-up; this change does not introduce a second media pipeline.
- Explicit composer folding is an in-session disclosure, reset with a new draft key. It is deliberately not a durable cross-page preference.
