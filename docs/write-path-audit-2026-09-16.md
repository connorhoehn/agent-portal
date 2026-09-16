# Write-path audit — 2026-09-16

**Lens.** Earlier passes audited what each nav item shows (empty and failed
reads, screen reader, laptop widths, request budgets). This one audits what
happens when the user does something: every POST/PUT/PATCH/DELETE the portal
issues, checked for eight properties — a pending lock on the control, success
feedback, failure surfaced with the server's text, the affected list
refreshing, a confirmation on irreversible writes, a 403 reading as "you
can't", the mock write mutating a registered fixture so reset undoes it, and
a form keeping its input on failure. Three flows were also observed live as
hr-admin (findings dismiss, bot resume, budget edit).

## What was found

The codebase was more disciplined than typical — most writes already had
pending locks, toast pairs, `refresh()` and the library `ConfirmDialog`. The
damage was concentrated:

- **Silent failures on money and approval writes.** Approve/reject in the
  approval queue restored the row on any non-403 failure with no message and
  no busy lock (a double click could double-fire). The canary reset swallowed
  the POST's rejection and reported success. Standing dispatch collapsed a
  403, a 409 money gate and a 500 into one "Needs authorizing" toast, losing
  the gate's `confirmFlag`. Quality feedback reverted the vote silently.
  Ingest schedules never checked `res.ok`.
- **Irreversible writes with no confirmation.** Grant revoke, job cancel,
  policy delete, publish to fleet, codebase unlink, PAT revoke, scoring
  exception decisions — one click each. Two raw `window.confirm`/`alert`
  calls (canary reset, calibration archive, policies validation).
- **Missing success feedback** on guardrail/mission edits, lineage publish,
  budget removal — and on the inline budget edit, where the mock also
  attributed every write to the release manager six days ago, so the row
  could never read back as the person who changed it.
- **Thirteen reimplementations of one helper.** Four `writeJson.ts` copies
  (two byte-identical; one whose comment said "when a third page needs it,
  lift it" unaware a fourth existed) plus nine one-off wrappers. Two of the
  silent failures sat exactly where a copy skipped error parsing, and the
  assessment DocPane showed `res.statusText` instead of the server's
  validation message for the same reason.
- **Mock write policy.** The local-compute dispatch loop's six writes were
  `unclassified`; the root cause was the mock job queue living in a bare
  module array outside the fixture registry, so reset could not undo a
  claim. `DELETE /nodes/:id` (unpair) was captured and working with no
  control calling it.

## Resolution (same day)

- `portal/src/lib/writeJson.ts` is the one helper (`writeJson`, throwing
  `sendJson`, `HttpError`): credentials always, `{ error, conflict, gate,
  confirmFlag }` parsed, 403 with no body reads as a permission message, the
  failure body kept as `data`. The kb copy is gone; sprints and local-compute
  copies are one-line re-exports; project-detail keeps its tree helpers over
  the shared calls; DocPane, Users, Promotions, DesignThread, Findings,
  GraphChanges and Rediscovery moved onto it. Node tests cover the helper.
- Approval queue: per-row busy lock and a pending → success/error toast
  chain. Schedules: `res.ok`, toasts, credentials, confirm before delete.
  Standing dispatch names the brake. Quality feedback reverts and says so.
- Library `ConfirmDialog` before: canary reset, grant revoke (names grantee
  and amount), job cancel, policy delete, publish to fleet (names bundle and
  session count), codebase unlink, PAT revoke (names the credential as
  shared), exception decisions, calibration archive, lineage publish, machine
  unpair (new control). Busy locks on each.
- Success toasts on guardrail/mission edits, lineage publish/review, budget
  set and removal. The mock budget write records the session's subject and
  the clock, so the ledger reads back attributed to the writer.
- Local-compute writes classified in the write policy; the mock job queue is
  a registered fixture so the loop is resettable (see the commit).
- Nine files gained `credentials: 'include'` ahead of the middleware moving
  to its own origin behind the ALB.

## Still open

- `workShared.tsx`'s `post()` remains for AssignJobModal, QueuePage and
  WorkHomePage; ~20 inline fetch blocks (bots, changes, library, guardrails,
  identity, canary, assessment) can migrate to the shared helper
  opportunistically.
- The `/api/identity/*` and `/api/session/*` write surfaces are skipped in
  the mock capture — no live Cedar/Aurora to seed from — so the most
  security-sensitive writes get no offline exercise.
- Middleware restarts still drop paired machines (in-memory presence).
