surface: new-request
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests/new
pages: portal/src/pages/access/RequestNewPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: new-request.jpg
verdict: fail — page title renders 14/600 instead of 20/600 (D1, platform-wide); the wizard itself and the submit passed
console errors: 0 on the wizard through all four steps; 1 expected 409 after submitting a duplicate of req-0001 (shown inline); on the real submit (req-0008) the redirect to the record logged the record page's 400 (D2)
layout: fail on title only — content col left 200 w 1480, top 44; trail "Request › Requests › New request" at 224/68; title at left 264 top 115 (indented 40px by the icon slot, not at the 24px gutter like the list pages); no horizontal scroll (1680/1680); 1 <main>; no table rows; screenshot new-request.jpg is the "Why" step with the counter at 89 characters
type: title 14/600 (h1), not the documented 20/600 — platform-wide today, /pipelines/runs as u-ines also measures 14px/600 (see DEFECTS.md D1); sizes in main at the Who step: 14/400x5, 12/600x6, 14/500x1, 14/600x1, 20/600x1, 13/500x1 (one 20/600 text node that is not the h1 — the stepper area, not identified)
keyboard: pass — 5 Tab stops at the Who step (two "Requests" crumb links, About New request, the radio, Next), all visited
empty-state: pass — Next is disabled with the reason on every unmet step: Who ok, What "Choose what to request from the catalog.", Why "Say why in at least 20 characters (9 so far)." (counter "89 of at least 20 characters" at 89), How long: Standing reveals "Why standing access?" textarea and keeps Submit disabled ("Standing access needs its own reason of at least 20 characters."); ?item=bogus is ignored (wizard opens on Who with no item); ?item=role:orgiq:org-leader preselects Org leader in Work
role-gating: pass — "Who is it for?" offers only "Myself (Rhea Castellanos)" (no report option: no DecideAccess); no policy Save, no Approvals/Configuration in rail; API: POST /api/access/requests {} 400 "itemId is required"; duplicate open request for SME in Work -> 409 "req-0001 already asks for SME in Work and is still open" (shown as an inline error, draft kept)
notes: Submitted as u-rhea: Member of Observability Platform, 7 days, justification "I am picking up the observability dashboards and need to dispatch agent work this sprint." -> redirected to /access/requests/req-0008, status submitted, chain Manager (Omar Haddad, current) then Steward (Priya Venkataraman, waiting), policy check clear, duration 7 days. First attempt with SME in Work was refused 409 (duplicate of req-0001); second attempt succeeded. Mock reset afterwards (Rhea's list back to four requests). Every field above was observed in this pass, not carried forward.
