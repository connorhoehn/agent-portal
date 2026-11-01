stretch item: two-reader realtime cursor proof
role: lead-assessor
user: u-jonas
url: /assessment/workspace?doc=page%3A100002
pages: portal/src/pages/assessment/WorkspacePage.tsx,portal/src/pages/assessment/knowledge
tenant: assessment; both readers confirmed through /api/session/me
audited: 2026-11-01T04:05:04.762Z (UTC), Chromium 148, 1680x940, local-ephemeral Tilt stack, Vite :5183 over middleware :3001, realtime gateway on; ui-components 2.485.0; fresh disposable clones, no shared reset
screenshots: realtime-cursors.jpg (Jonas sees Farah), realtime-cursors-reverse.jpg (Farah sees Jonas), both from this run
verdict: pass — both readers receive the other reader's labelled pointer, follow a second movement, draw no self pointer and remove the peer on leave; the outsider receives two channel refusals and no cursor data
console errors: 0; blocked business writes: 0

The final proof ran after the current rail, layout and typography contracts
were measured. `portal/e2e/document-cursors.spec.ts` passed with no retries.
The screenshots were inspected. Machine-readable observations are in
[realtime-cursor-proof.json](realtime-cursor-proof.json), and the cursor-only
wire capture is in [realtime-cursor-diagnostics.json](realtime-cursor-diagnostics.json).
Neither artifact contains session tokens or cookies.

| Direction | Arrival | Second movement | Leave cleanup |
|---|---:|---:|---:|
| Farah → Jonas | 29 ms | x=783.95 → 1389.70 in 409 ms | 586 ms |
| Jonas → Farah | 26 ms | x=783.95 → 1389.70 in 430 ms | 583 ms |

Each direction begins with zero peer pointers. Labels are `Farah Osei` and
`Jonas Lindqvist`, supplied by the authenticated identity. Leaving for the
Assessment team list removes the pointer from the other reader's canvas.
The outsider attempts both subscribe and update, receives exactly two
`AUTHZ_CHANNEL_DENIED` frames and receives zero cursor frames.

Actors: `u-farah-clone-8967de65` (program-lead),
`u-jonas-clone-e5c6ecad` (lead-assessor), and
`u-theo-clone-004d6868` (OrgIQ member, no Assessment grant).
All clones and browser contexts were closed after the proof. The existing
Rubric Overview canvas was only read: the browser allowed its grant and
presence requests while blocking other HTTP business writes. No document
text, comment, chat message or call was created.

An earlier run missed the second movement while the full library tests were
also running. The later diagnostic, packed-build preflight and this final
serialized run passed; no extra movement retry or timing delay was added to
hide that observation. The earlier failure remains in the continuation
report and `.scratch/journey-repair-2026-10-31/assessment-cursors-confirm.log`.

This renewal covers cursors and channel isolation. It does not renew typing,
chat edit/delete, forwarding, co-editing, comments or SFU media. Their complete
earlier records are preserved in
[the historical log](../../history/assessment-stretch/realtime-through-2026-10-24.md),
separate from this run's passing verdict.
