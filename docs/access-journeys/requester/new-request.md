surface: new-request
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests/new
pages: portal/src/pages/access/RequestNewPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: new-request.jpg
verdict: pass
console errors: 0 through all four steps, the submit and the redirect to the new record
layout: pass — content col left 200 w 1480, top 44; trail "Request › Requests › New request" at 224/68; exactly 1 h1 ("New request", 20/600) at left 264 top 111 because a "Requests" back link occupies the title row from 224; no horizontal scroll (1680/1680); 1 <main>; no table rows; new-request.jpg is the "Why" step with the counter at 89 characters
type: title 20/600 (h1); sizes in main at the Who step: 14/400x5, 12/600x6, 14/600x1, 14/500x1, 13/500x1 (the single radio label "Myself (Rhea Castellanos)", a library RadioGroup size slightly off the 12/14 scale — minor, DEFECTS.md), 20/600x1
keyboard: pass — 5 Tab stops at the Who step (two "Requests" crumb/back links, About New request, the radio, Next), all visited
empty-state: pass — Next is disabled with the reason on every unmet step: What "Choose what to request from the catalog.", Why "Say why in at least 20 characters (9 so far)." (counter "89 of at least 20 characters" at 89), How long: Standing reveals "Why standing access?" and keeps Submit disabled ("Standing access needs its own reason of at least 20 characters."); ?item=bogus is ignored (wizard opens on Who, no item)
role-gating: pass — "Who is it for?" offers only "Myself (Rhea Castellanos)" (no report option: no DecideAccess); no policy Save, no Approvals/Configuration in the rail; API: POST /api/access/requests {} 400 "itemId is required"
notes: Submitted as u-rhea: Member of Observability Platform, 7 days, justification "I am picking up the observability dashboards and need to dispatch agent work this sprint." -> redirected to /access/requests/req-0007, status submitted, chain Manager (Omar Haddad, current) then Steward (Priya Venkataraman, waiting, flagged "escalated": the steward holds no deciding role in Access), policy check clear, duration 7 days. Mock reset afterwards. Every field above was observed in this re-walk, not carried forward.
