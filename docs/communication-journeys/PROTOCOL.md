# Journey audit protocol — Communication plane

Logs under `docs/communication-journeys/<dir>/<surface>.md` plus a
screenshot beside each, judged by `scripts/validate-communication-plane.sh`
(item 5) against `docs/communication-plane-goal.md`. Field names, sign-in,
measuring and the keyboard/empty-state/realtime steps are those of
`docs/social-journeys/PROTOCOL.md`; read it first. Required fields: `surface`,
`role`, `user`, `url`, `audited`, `screenshot`, `verdict: pass`,
`console errors`, `layout`, `keyboard`, `empty-state`, `realtime`. The words
TODO, unverified and placeholder make a log not count.

| dir | user | tenant | surfaces |
|---|---|---|---|
| member | u-theo | orgiq, member | rail, active-now, groups, org-teams, shared-work, footer-social |
| org-leader | u-vera | orgiq, org-leader | same six |
| assessment | u-asha | assessment, assessor | rail, active-now, groups ("My teams"), shared-work, footer-social |
| pipelines | u-tomas | pipelines, author | rail, active-now, groups ("My pipelines"), shared-work, footer-social |
| no-grant | u-hr | orgiq, hr-admin, no Social grant, no linked person | rail (denied state), footer-social; the log must record **zero** `/api/social` requests |

Surfaces: **rail** (shelf, Active now, groups, org teams, Teams, Rooms, DMs,
Channels in order, flush at x=200); **active-now** (u-mira online, in-call and
activity text, tile → DM, work-sharing mark → shared work); **groups** (My
initiatives / My teams / My pipelines, bound channel, unread, live-call dot,
unbound → page discussion + Bind, unlinked-person row); **org-teams** (My org
teams, team view, Create team channel for `ManageTeams`); **shared-work**
(person's shared work: empty for an outsider, populated after u-mira shares;
conversation Shared work view; far-right pane open); **footer-social** (lands
on `/<tenant>/communication`, `/social/channels` inside Social).

Seal one directory at a time, after walking it:
`scripts/journeys/seal.sh docs/communication-journeys/<dir>`. Freshness and sealing follow [docs/journeys.md](../journeys.md): a log is stale when the rendered contract of a route its `url:` names changed since its walk was sealed (sweep measurements, gate, the assertions of the specs that cover it), and only `scripts/journeys/seal.sh <dir>`, after a walk, seals it.
