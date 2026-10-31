# Journey continuation — 2026-10-31

Resumed from `7dd22dc9` and `docs/local-backlog-goal-2026-10-28.md`.
The app's rendered contracts are measured on the current source. The first
walks found failures beyond stale seals; passing maps alone are eligible for
sealing. No expectation or audit burn-down entry was relaxed.

## Execution

| Family | Maps | Passed | Failed | Held | Status |
|---|---:|---:|---:|---:|---|
| Pipelines | 55 | 17 | 38 | 0 | All walked; 17 passing logs sealed |
| Social | 48 | 31 | 13 | 4 | All runnable maps walked; 31 passing logs sealed |
| Assessment | 57 | — | — | 0 | Walking |

These are executable-map results. Assessment's older stretch proofs are
separate records; the map count does not claim to re-prove them. Social's four
activity maps remain held: their live notification proof needs a chat write
that the shared gateway cannot isolate in a mock scope. They were not re-sealed.

## Runner and map repairs

- Coverage generation reads the generated tenant registry after DE-29 instead
  of parsing declarations that no longer exist in `session.ts`. Its denominator
  includes the cross-tenant administrator role in each tenant. The report
  explicitly distinguishes static map coverage from executed, passing walks.
- Social inbound maps now prove forged chat join/history and presence
  subscription refusals for identities without a Social grant. The bounded
  probe closes its socket, rejects leaked channel data and records no token or
  message content. It uses the token endpoint's gateway URL or the same public
  Vite setting the portal uses.
- Social channel keyboard steps target the current accessible row name while
  retaining the same Enter-and-navigation assertion. Unknown-hangout steps
  expect only the specific missing-room 404, rather than swallowing unrelated
  console errors.
- Negative-text assertions wait for the expected live update, using the same
  bounded polling as positive assertions. Text that remains still fails;
  global regular expressions cannot alternate into an accidental pass.

## Findings to resolve

Pipelines' surface failures recur across the four roles:

- Run detail: `DetailSection` heading order and `ActivityFeed` text contrast.
  Owners: `portal/src/pages/pipelines/RunDetailPage.tsx`,
  `portal/src/components/ChannelActivity.tsx`, and the shared component library.
- Missing pages: no primary heading, low-contrast title and oversized raw
  keyboard hint in `portal/src/pages/NotFoundPage.tsx`.
- Missing approval: two primary headings; the nested `RecordNotFound` call in
  `portal/src/pages/pipelines/ApprovalsPage.tsx` needs the embedded heading size.
- Definition records expose a raw bot UUID in the header; promotion warnings
  and the configuration description also fail contrast.
- Audit-policy issue: `/pipelines/runs/does-not-exist` is required to have a
  composer even though the visible missing-run state has no discussion.
  Any correction needs positive missing-record evidence and must retain the
  composer requirement on loaded runs and collections.
- One Approvals measurement moved between the two audit frames. It remains a
  failed stability observation, not a new exemption.

Social has 13 failed maps after the repairs and confirming walks:

- Calls, all four roles: two primary headings (`Calls`, `Calls`).
- Configuration, all four roles: contrast findings in the permission matrix;
  two roles also trip the repeated-content heuristic on adjacent `Yes` cells.
  Review that heuristic against the table semantics before treating repeated
  permission values as a product defect.
- DMs, all four roles: control typography; two also report conversation
  metadata typography. The three roles with copied DMs attempt
  `POST /api/social/dms/read` on opening a conversation. The read-only walker
  blocks the receipt write. Prove isolation of this write before permitting it;
  do not call it a read-only request merely because it marks a message read.
- Participant Channels: the Documents tab moves between the two audit frames,
  reproduced on the confirming walk. The moderator's equivalent measurement
  passed on confirmation; that map is sealed. The original failure remains in
  `.scratch/resume-2026-10-31/social-rewalk.log`.

All four hangout maps now pass with the signalling fixture. This proves the
live occupancy UI, not SFU media. Both no-grant gateway probes pass against the
actual local gateway: join returns `not-a-member`; history and presence return
`AUTHZ_CHANNEL_DENIED`; zero channel frames are disclosed. All 31 passing
Social maps were checked with the freshness judge and are fresh.

Per-map evidence is in `docs/{pipelines,social,assessment}-journeys/`.
Detailed step results, screenshots and command output for this continuation
are under `.scratch/journeys/` and `.scratch/resume-2026-10-31/`.

Budget defaults and AWS rollout work remain in the original backlog document;
this continuation does not decide those product/money choices or apply cloud
changes.
