surface: team-scorecard (focused responsive audit)
role: admin
user: u-operator
url: /assessment/teams/TEAM-001
pages: portal/src/pages/assessment/dashboard/TeamScorecard.tsx,portal/src/pages/assessment/dashboard/DimensionMasterDetail.tsx,portal/src/pages/assessment/dashboard/DimensionDetailHeader.tsx,portal/src/components/shell/Layout.tsx,portal/src/app.css
audited: 2026-09-20, isolated Playwright Chromium context, portal 127.0.0.1:5183 and existing middleware 3001
screenshot: after/desktop.png
verdict: partial — responsive layout and interactions pass; the shell's existing gateway connection still logs HTTP 404 handshake failures
console errors: 7 in the final run — six shell ws://localhost:3001/ws handshake failures, one expected HTTP 404 for TEAM-999; zero JavaScript exceptions
layout: pass — desktop 1500px: content left 224px, width 1252px, rail 340px, detail 910px; tablet 768px: content 520px, stacked rail/detail 518px inside borders; phone 390px: content left 24px, width 342px, detail 340px; document scrollWidth equals viewport at all three widths
keyboard: pass — 47/47 visible enabled controls reached through actual Tab presses on desktop; Enter and ArrowDown select dimensions; Escape closes Team details and mobile navigation; Enter activates the phone Documents tab
empty-state: pass — unmatched dimension filter explains no matching dimensions; TEAM-999 shows "No team TEAM-999" and "Back to the dashboard"
role-gating: this audit used the real admin assessment context, confirmed by /api/session/me; mobile destinations come from the same existing role-filtered subNavItems as the desktop rail. Other roles were not re-audited in this bounded pass.

The before images record the defect, including why a horizontal-scroll-only
check misses it. At 768px the 340px rail left only 178px for detail and title
metadata overlapped. At 390px the permanent shell rail left 142px of content
and the dimension rail extended beyond that pane, although the document itself
reported no horizontal scrolling. See before/observations.json and the actual
before/tablet.png and before/mobile.png captures.

The correction continues to use the shipped MasterDetail, PageHeader,
StatStrip, Inline, and DropdownMenu. Below 1024px the dimension rail becomes a
full-width bounded scrolling list above the detail. Header actions and detail
metadata wrap. The four metrics form two columns. Below 768px the shell's
primary rail is replaced by the shared Navigation menu using the same
capability-filtered destinations; nested page rails are unaffected. The
header actions also wrap within the viewport. The accelerator's existing
TeamScorecard.tsx uses wrapping header groups; this preserves that behavior
without copying its layout implementation or introducing a new UI component.

All five team tabs and all five detail tabs were selected. Dimension 4 remained
selected after leaving Certification and returning. The claims filter showed
six actual matching dimensions. Team details showed the two repository links;
Escape closed the drawer. Mobile Navigation opened, closed on Escape, and
routed Dashboard to /assessment/teams. Browser Back returned to TEAM-001.
The phone tabs remain horizontally scrollable in the shared Tabs component;
Documents was focused and activated by Enter successfully.

The audit did not change assessment data, score a team, publish anything,
restart a service, or reuse personal browser cookies. The isolated operator
session was created through the existing picker and workspace selector.
Console failures are preserved verbatim in after/observations.json rather
than excluded from the count. The expected missing-team HTTP 404 is identified
separately from the unresolved shell gateway configuration.

Validation: portal production build passed; all 931 portal tests passed;
component discipline and navigation parity checks passed. The repeatable
read-only probe is scripts/research/team-certification-audit.cjs. Its output
folder is set with TEAM_AUDIT_OUTPUT; it now asserts no document horizontal
overflow at 1500, 768, and 390 pixels. No unrelated historical journey digest
was refreshed by this pass. This focused evidence does not claim the full
role-by-surface journey matrix is current.
