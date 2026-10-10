surface: prompt-studio
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/prompts
pages: portal/src/pages/capabilities/PromptsPage.tsx,portal/src/pages/capabilities/PromptsFrame.tsx,portal/src/pages/capabilities/prompts
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: prompt-studio.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Prompt Studio"); first-row-top: 311px; clipped-text sweep: clean. Prompt Management rail at x 224 (Browse / Ops / Author: Studio, Versions, Evals / Ship); six prompts listed with names and descriptions that wrap rather than cut (0 cut strings); editor beside it with the template, version select, Test and Edit
keyboard: pass — 24 of 24 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /iq/prompts to /iq/library. Enter on Edit moves focus into "Prompt template"; Escape closes the editor and focus returns to the Edit button (read after forced frames, again after a second wait); Enter on Test focuses the first input and Escape returns focus to Test
empty-state: pass — "zzznoexist" in "Search prompts…" gives "No prompts found." and keeps the editor on the selected prompt
role-gating: can read and select prompts, and open Test and Edit (ManageCanary true). Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Both earlier prompt-studio defects (focus lost after leaving Edit/Test, and cut prompt names with no title) do not reproduce on this build.
