surface: new-request
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests/new
pages: portal/src/pages/access/RequestNewPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 14:56–15:03 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: new-request.jpg
verdict: pass
console errors: 0 through all four steps, the submit and the redirect to the new record
layout: pass — content col left 200 w 1480, top 44; trail "Request › Requests › New request" at 224/68; exactly 1 h1 ("New request", 20/600) at left 264 top 111 (a "Requests" back link occupies 224–264 of the title row); no horizontal scroll (1680/1680); 1 <main>; no table rows; new-request.jpg is the Why step with the counter at 89 characters
type: title 20/600 (h1); sizes in main at the Who step: 14/400x5, 12/600x6, 14/600x1, 14/500x2, 20/600x1. The radios are on the scale now: "Myself (Rhea Castellanos)" 14/500; How long: 8 hours / 24 hours / 7 days / 30 days / Standing each 14/500 with the hint "This item’s default" at 12/400 (was 13/500)
keyboard: pass — 5 Tab stops at the Who step (the crumb and back "Requests" links, About New request, the radio, Next), all visited; Escape on the How long step does not leave the wizard (URL unchanged)
empty-state: pass — Next is disabled with the reason on every unmet step: What "Choose what to request from the catalog.", Why "Say why in at least 20 characters (0 so far)." then "(9 so far)" at "too short" (counter "9 of at least 20 characters"), enabled at 89; How long: Standing reveals "Why standing access?" and keeps Submit disabled ("Standing access needs its own reason of at least 20 characters."); ?item=bogus is ignored (wizard opens on Who, no item); ?item=role%3Aorgiq%3Aorg-leader pre-selects "Org leader in Work"
role-gating: pass — "Who is it for?" offers only "Myself (Rhea Castellanos)" (no report option: no DecideAccess); the item list marks "Member of Auth Migration (you hold this)"; no policy Save, no Approvals/Configuration in the rail; API: POST /api/access/requests {} 400 "itemId is required"; POST with beneficiaryId u-nora (curl jar as u-rhea) 403 "Requesting on behalf of someone else needs DecideAccess"
notes: Submitted at 14:59:07 as u-rhea: Member of Observability Platform, 7 days, justification "I am picking up the observability dashboards and need to dispatch agent work this sprint." -> redirected to /access/requests/req-0008 (req-0007 already existed from another lane), status submitted, chain Manager (Omar Haddad, current) then Steward (Priya Venkataraman, waiting, "escalated": the steward holds no deciding role in Access), policy check clear, 1 audit event. Back from How long returned to Why with the text kept. Mock reset by this walker at 15:00:08 after this write (POST /api/__mock/reset 200). Every field above was observed in this re-walk, not carried forward.
