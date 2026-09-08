surface: computer-lab
role: sme
user: u-nora (Nora DaSilva); re-confirmed via GET /api/session/me on this page (sub u-nora, role sme, tenant orgiq)
url: /admin/devbox
pages: portal/src/pages/admin/DevboxPage.tsx
audited: 2026-09-05 19:27 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: computer-lab.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; the lab frame fills the content box (LAB header at 104px); first-row-top: 155px (the "computers 0 / nothing here" list — the seed provisions 0 computers so there is no row, the empty list itself is the first thing under the header); no card stack above the list; no horizontal scroll (1552/1552)
keyboard: pass — 26 tabbable (the "+" pane-split and "send" buttons are `disabled` with 0 panes/targets and correctly skipped), all 26 reached in one sweep and verified by diffing the focus log against the DOM: "?" help, the "new"/"menu"/"all" list-header actions, "+ new computer", the "▶ focused pane" target toggle and the broadcast textarea are real controls; "menu" opens the "Keyboard shortcuts" dialog (⌘⏎ new pane, ⌘⌫ close pane, ⌘⇧F zoom, ⌘⇧E switch pane kind…) and Escape closes it; ⌘I opens the COMPUTERS quick-switcher and Escape closes it
empty-state: pass — "No computers to lab / Computer Lab multiplexes a fleet. Provision at least one computer and it will open in a pane." with a "+ new computer" CTA (not pressed — provisioning a devbox is a real microVM with cost, out of scope for an audit pass); the computers and agents lists each read "nothing here"; ⌘I with an empty fleet reads "No computers yet — create one below, or open Computer Lab." and offers "+ New computer · fresh microVM workspace" as its only row
role-gating: sme holds ManageDevbox and is in the route's RequireRole list, so Computer Lab is in the rail (Build group), the page renders rather than redirecting, and "+ new computer" is enabled — the surface a dispatching SME needs to dry-run a bundle or watch a worker; nothing on the page is hidden from sme relative to hr-admin
notes: With 0 computers the page is honest and quiet. Two small things: the "menu" button opens what is titled "Keyboard shortcuts", so the label and the content disagree; and the empty state says "Provision at least one computer" while Session config's refusal said "verify this bundle on at least one box" — the same object is a computer here and a box there.
