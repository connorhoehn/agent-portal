surface: runs
role: admin
user: u-operator
url: /assessment/runs
pages: portal/src/pages/assessment/RunsPage.tsx
audited: 2026-09-05 07:50 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: runs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 44 interactive controls on initial load; run-id cells and the team select in the launcher are native and Tab-reachable; Escape closed the detail drawer (confirmed "Stopped by operator" text gone from `document.body.innerText`).
empty-state: n/a — the ledger and launcher both have data (7 commands in the allowlist, 7 teams selectable).
role-gating: admin holds the same RunAssessmentAgent authority as assessor/lead-assessor/program-lead — can pick a team, Run any of the 7 allowlisted commands (classify-transcript, extract-enterprise-context, validate-outputs, process-self-assessment, develop-jira-story, draft-confluence-page, suggest-confluence-content, draw-diagram), and Stop a running one. Nothing here is admin-exclusive.
notes: Nav label for this surface is "Activity" (SYSTEM group), not "Runs" — the URL is /assessment/runs but the rail item and page heading both read "Activity", matching every other role's audit of the same page. Launched classify-transcript for TEAM-007 (Internal Tools) via the team select + Run button — a "Run started" toast fired, and a new row (run-20260905T055011Z-classify-transcript-030905aa7d46) appeared at the top of the ledger as "running" then flipped to "completed" (just now / 0m 08s) live over SSE (green connection dot next to "Activity"), with no manual refresh. Also opened the still-running TEAM-003 score-dimensions run's detail drawer and clicked "Stop": it genuinely transitioned to "failed", Duration "43m 54s", Summary "Stopped by operator before score-dimensions finished.", Error "stopped by operator" — a real state change, not client-only.
re-verified 2026-09-05 07:50 (gateway mode): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 42 interactive controls (unchanged); ledger top rows now show this session's stretch/Part-4 runs: `process-self-assessment` for TEAM-006 and TEAM-005 (both completed, 0m 08s, from the submissions-wizard re-run) above `score-dimensions` for TEAM-007 (completed, from stretch/agent-e2e.md Part 2). The previously-flagged stuck run (`run-20260904T091140Z-score-dimensions-cc10aa77ff02`, TEAM-003) is STILL "running" at 50m ago — confirms it is genuinely orphaned (already tracked in lead-assessor/DEFECTS.md).
