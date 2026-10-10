# Escalation review 2026-10-06

The escalation was a false alarm. The failed gate ran while a dependency install was still writing files, so it checked a half-installed ui-components. Neither finding needs a code change in the portal now.

## Verified findings (ranked)

| # | file:line | verdict | fix location | sketch |
|---|---|---|---|---|
| 1 | `portal/src/components/shell/SocialFooter.tsx:107` | **The gate result is invalid; the code is not at fault.** `gates.log` was written at 12:16:36. The installed `dist/video.d.ts` was written at 12:16:42, six seconds later. That means the nav-parity `portal tsc` step type-checked against the old or partly written dist. The lockfile resolves e653d0b2 as 2.416.0 (`portal/package-lock.json:1408-1410`). That dist includes `'idle'` in `HuddleBarPhase` (`dist/video.d.ts:1635`, `dist/index.d.ts:10553`), so `phase="idle"` is valid. | portal (process only) | Re-run `./scripts/validate-nav-parity.sh` now that the install has finished; I expect `tsc` to pass, but I did not run it (read-only). Separately, `run.sh` should refuse to start its gates while `portal/node_modules` is newer than the run directory or an `npm install` is running. Otherwise a pin bump in another session produces a false red every time. |
| 2 | `portal/src/pages/social/socialChat.ts:68`, `middleware/src/lib/social-chat.ts:58` | **Real but low, and legitimately local.** The DM prefix is worked out by calling `dmLobbyName(['a','b'],{prefix:'social:'})` and slicing off the tail. The library documents `startsWith('dm:')` checks as a bug class because they miss hashed `dmg:` lobbies (`realtime-modules/dist/call/lobbyChannel.d.ts:37-48`). That bug doesn't apply here. Social only builds channel names with `dmLobbyName` (`social-chat.ts:83-85`), which never produces `dmg:`; only chat's `dmChatChannelFor` does. Every middleware call site also fails closed on `null`: `chat-pins.ts:88`, `routes/social.ts:278,316`, `realtime-gateway.ts:586`. Authority checks stay on fresh directory reads and are untouched by this. | realtime-modules (optional, low priority) | Remove the slice trick by exporting a tenant-aware parser from `/call` and `/client/video`, for example `parseDmLobby(lobby, { prefix }): { form: 'dm' \| 'dmg'; members: string[] \| null } \| null`, or a `DM_LOBBY_SEGMENT` constant. Then the portal's `dmMembers`, `SocialChatWorkspace.tsx:133,250,339` and the middleware `dmMembers` all delegate to it. Do not add any caching to it. |

The Sonnet auditor's other notes are coverage gaps, not findings: it didn't check the colour inline styles or stale exemptions, and didn't compare against realtime-examples. Nothing there for me to verify, so carry them forward to the next pass.

## Rejected findings

- **#1 as a type or pin defect:** dropped, because the installed 2.416.0 dist accepts `'idle'`; the only fault is the gate racing the install.
- **"useWorkEvents / useAssessmentEvents should move to a gateway channel"** (from the Sonnet notes): dropped, because it is unverified speculation. Both are BFF SSE feeds, and no library hook for those event types exists.

## Library work to batch into one release

- **realtime-modules:** the `parseDmLobby(lobby, { prefix })` export from finding 2, with tests covering both the `dm:` and `dmg:` forms, with and without a tenant prefix. It isn't urgent. Add it to the next realtime-modules release rather than cutting one for it.
- **ui-components:** nothing new. Finding 1 needs no library change.
- **Portal now:** re-run the nav-parity gate once, and add the install guard to the audit runner (`scripts/audit-loop/run.sh`). I made no edits.
