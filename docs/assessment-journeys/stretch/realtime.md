stretch item: two-tab realtime proof
role: lead-assessor
user: u-jonas
tenant: assessment (confirmed in both tabs via `fetch('/api/session/me')` → `{"sub":"u-jonas","role":"lead-assessor","tenant":"assessment"}`)
pages: portal/src/pages/assessment/WorkspacePage.tsx,portal/src/pages/assessment/knowledge
audited: 2026-09-07 04:41–05:02 local, Chrome, three tabs at 1560x757, middleware dev:mock on 127.0.0.1:3011 behind the Vite proxy (`curl localhost:5183/api/health` → `{"service":"orgiq-middleware"}`) — full re-run after the fix that stopped the cross-tab save notice freezing its age
screenshots: realtime-notice-ages.jpg (tab A at 7 min 24 s after the save it describes, the banner reading "Updated by u-jonas 6m ago" with its Dismiss control — the same shot that used to read "just now"), realtime-tab-a.jpg and realtime-tab-b.jpg (the previous pass's two-tab save/comment exchange, unchanged and still accurate), realtime-stale-just-now.jpg (kept as the historical evidence of the defect this run closes)
verdict: pass — the banner now ages honestly, which was the last thing wrong with this surface. Everything the earlier runs proved still holds: presence collapses two tabs of one user to one avatar with a ×2 count, a save in one tab reaches an already-open peer tab with no reload and no clobber, a fresh tab is told nothing, and a user switch leaves no inherited suppression. No open defect remains against this proof.
console errors: 0 in all three tabs, read after the save exchange, after the focus sweeps on the four explorer surfaces, and after the document read/edit/drawer states.

## Environment as found

Unchanged and deliberately not reconfigured. `portal/.env.local` sets `VITE_GATEWAY_URL=http://localhost:3001`, which is not this project's middleware (that is on 3011 this session, because an unrelated `platform-api` holds 3001), so the portal's realtime hooks point at a foreign server. Read from the DOM rather than inferred:

- shell header badges: `aria-label="gateway HTTP status: unhealthy"` (red) and `aria-label="gateway WebSocket status: reconnecting"`
- document pane pill: green dot, **"Live"**, with the amber qualifier **"Gateway offline — presence and co-editing via the BFF"**

So this is the BFF-only path, and the pill says so.

## Setup

One signed-in user (Jonas Lindqvist, lead-assessor) with the same cookie in two tabs, both on `/assessment/rules?doc=rule:scoring-guardrails.md` ("Scoring Guardrails" — `INTERNAL`, `editable`, 326 characters, with Edit/Publish/History/Comments). Tab A was opened first and left alone; tab B did the editing. A third tab was used for the surface audits so tab A was never navigated. Workspace is not usable for the edit half of this proof: its pages are Confluence-synced, `doc.editable` is false, and they expose only Comments. Rules is where a user can actually author, which is why the defect lived here.

## The fix under test — the banner ages

Tab B opened Edit (body textarea populated with all **326** characters, reached as `main textarea[aria-label$="document body"]`, since the first textarea in document order is the version-label field), appended one line, and saved at **08:41:43.616Z**. Tab B showed **no** self-notice and wrote one timestamp into its own-save set. Tab A, untouched from then on, was read at intervals:

| elapsed since the save | banner text | `relativeTime` would say |
|---|---|---|
| 7 s | "Updated by u-jonas **just now**" | just now (correct) |
| 1 min 37 s | "Updated by u-jonas **just now**" | just now (correct — the cutover is at two minutes) |
| 2 min 27 s | "Updated by u-jonas **2m ago**" | 2m ago |
| 3 min 09 s | "Updated by u-jonas **3m ago**" | 3m ago |
| 5 min 40 s | "Updated by u-jonas **5m ago**" | 5m ago |
| 7 min 24 s | "Updated by u-jonas **6m ago**" | 7m ago — one minute behind, see below |
| 9 min 03 s | "Updated by u-jonas **8m ago**" | 9m ago — same lag |
| 9 min 03 s, tab foregrounded | "Updated by u-jonas **9m ago**" | 9m ago |
| ~20 min | "Updated by u-jonas **20m ago**" | 20m ago |

The three readings the defect was filed on — 2 min 20 s, 2 min 48 s and 7 min 54 s, all reading "just now" — are gone: at 2 min 27 s it reads "2m ago" and it keeps counting. The wording is now derived at render from `{ by, ts }` notice state rather than being formatted once into the state at effect time, so any re-render re-reads the real age.

**The one-minute lag is the harness, not the page.** Tab A was a background tab for most of this run, where Chrome throttles timers to roughly once a minute, so the 15-second presence heartbeat that drives the re-render fires far less often. The banner therefore trails by up to one throttle interval. Foregrounding tab A at 9 min 03 s made it read "9m ago" immediately, and the 20-minute reading was exact. A person watching a tab they are actually looking at sees it within 15 seconds; nobody sees it frozen.

## The two neighbouring behaviours, re-confirmed in the same run

**A fresh tab is told nothing.** Tab A itself was opened *before* the save and had no banner on arrival. A third tab opened on the same document **3 minutes after** the save showed no banner either, with `sessionStorage['assessment.knowledge.ownSaveTimestamps']` absent and only `assessment.knowledge.tabId` present. A fresh SSE connection presenting no `Last-Event-ID` replays nothing from the ring; the age bound and gap behaviour on a genuine reconnect are pinned by the 11 passing `decideReplay` unit tests.

**A user switch leaves no stale suppression.** Tab B, holding exactly one confirmed own-save (`["2026-09-07T08:41:43.619Z"]`), was signed in as u-asha in place through the `/select` "Sign in as" flow. Afterwards `assessment.knowledge.ownSaveTimestamps` was **gone** while `assessment.knowledge.tabId` was **unchanged** (`f7807877-…`) — the right split, since the tab id identifies the tab and the own-save set identifies the person. The incoming session inherits no reason to stay quiet about the outgoing user's edits. Tab A, which kept its banner across the switch, went on ageing it correctly ("10m ago", then "20m ago") even as the underlying session became a different user, which is the honest behaviour: the banner describes an event, not a session.

## Presence — works

Both tabs render the same roster entry: one avatar carrying a ×N multiplier inside a group labelled `aria-label="Online users"`, not two avatars and not a ghost second user. Both tabs were `document.hidden === true` for most of the run (this harness never foregrounds them) and the count was still correct, so the BFF heartbeat does not depend on visibility.

## Editor and live delivery — unchanged

Opening **Edit** gave a body textarea holding all 326 characters with `aria-label="Scoring Guardrails — document body"`; the version field carries `aria-label="Version label (optional)"`. Saving round-tripped: the card returned to read mode with the new paragraph rendered, and the assessor and program-lead passes later in this session both read the saved text as ordinary content. Tab A had already refetched the document when its banner appeared — the new line was in its rendered body — with no reload and no clobber, round trip under 7 seconds over the BFF. The banner's Dismiss control resolves `aria-label="Dismiss"`. History listed three versions with absolute timestamps, byte sizes and Restore actions.

One trap worth repeating for anyone driving this from a script: `document.querySelector('main textarea')` returns the **version-label** field, not the body, and reads length 0 on a fully populated editor. That is a selector mistake, not an empty editor. Two more from this harness: a double-rAF focus wait never resolves in a background tab and hangs the evaluation (use `setTimeout`), and a synthetic Enter `keydown` does not activate an `<a>` or `<button>` (use a real `.click()`; a dispatched Escape does work).

## What is still wrong

Nothing on this proof. The banner's age is now correct within one re-render, the arrival-time silence holds, and the own-save set does not survive a user switch. DEFECTS.md #6 is closed in all four role ledgers with the timings above.

--- freshness re-observation, 2026-09-16 01:50 (portal/src/pages/assessment changed: three Card lists → DataTable) ---
Why: the last three open audit findings for this tenant; re-observed as u-asha (/assessment/runs, /assessment/submissions, the wizard) and as u-operator (a knowledge doc's History).
  RunsPage's command panel is a DataTable; the ledger's live event wiring (the SSE-driven progress on running rows) is untouched and was re-observed on 12 ledger rows as Asha.
Console errors: 0.

--- freshness re-observation, 2026-09-16 09:10 (portal/src/pages/assessment changed: a11y + responsive pass) ---
Why: the screen-reader and narrow-width audits; re-observed as u-asha on TEAM-001 and the enterprise explorer.
  No runtime path changed; the scorecard pane heading level and the explorer rail width are markup/CSS only.
Console errors: 0. Re-audit 2026-09-16 06:35: Write-path pass: DocPane writes use the shared helper; the realtime doc path is unchanged. Code-verified. Console errors 0.
