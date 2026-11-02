# Runbook review and shared audit profiles

Runbook proposals retain an application review layout: breadcrumb/title, numbered
contents, change summary, code diff, review checks and proposed procedure. The
section controls move forward/backward or return to contents. Code lines remain
complete inside a horizontal scroller.

## Shared repairs

- Diff file actions use the shared SVG chevron and 12px status/count labels.
  Filename text has a semantic code wrapper; other action text keeps UI typography.
  Additions/removals and change labels use their full foreground tone for contrast.
- Wrapped `Text` keeps inline code and ordinary text in one sentence flow instead
  of laying each fragment out as a separate flex item. This fixes runbook
  expectation/instruction prose containing inline marks.
- Application outlines and compact disclosures use 12px entry insets; review
  cards and medium callouts use 16px padding. Sources use flat selectable rows. Application loading rows use the 20px spinner and 8px gap.
- Code diffs, hunk coordinates and +/- gutters have explicit measured profiles in
  the shared UI audit. Normal tables retain their ordinary row/type/padding checks.
- Composer mode controls are measured from their own border: 12px docked or 8px
  compact. Comparing that inner grid with a 24px page reading gutter caused the
  previous 4px command-help findings. The outer composer placement, control
  typography, contrast, keyboard focus and overflow checks remain active.

The valid/broken fixtures cover diff fonts, line heights, cell padding, preserved
whitespace, horizontal scroll ownership, change-strip insets, composer insets,
and nearby ordinary controls/tables. Removing the diff marker restores ordinary
table and column-share checks; it is not a blanket exemption.

## Verification

The app pins the packed ui-components **2.499.4** (source `52e64396`, release
`15a478aa`). All 339 installed distribution files match the archive byte for
byte; SHA256 `53847411389972e1c020902b027bd780ce749c9c7b39d5a60de00d99938a83ec`.
The Vite dependency cache was refreshed and the served semantic markers verified.

- Library: 1,028 test files pass, 11,302 tests pass, 2 existing skips; source/demo
  lint and production build pass. Audit mutation fixtures and skill validation pass.
- App: typecheck passes. The isolated browser test blocks business writes and
  verifies delayed library loading, TOC/previous/next/back navigation, file
  collapse/reopen, complete horizontal diff scrolling and command help in both
  themes at 900/1440px. Final scoped Search navigation and actual keyboard
  focus walks on Runs, Designs and Decisions also pass on this release.
- Proposal deep audit: **24 cases, zero findings, zero unclassified policies**.
  `.scratch/proposal-review-2026-11-02-verified/report.json`.
- Runbook deep audit: **25 cases, zero findings, zero unclassified policies**.
  `.scratch/runbook-review-2026-11-02-verified/report.json`.
- Scoped Search regression: **21 deep cases, zero findings, zero unclassified
  policies** on the same release;
  `.scratch/scoped-search-2026-11-02-release-verified/report.json`.

The proposal audit initially caught an asynchronous merge-target lookup adding
an entry to an already visible contents list, moving the footer controls between
measurements. ProposalReview now waits for that initial lookup. The delayed
response browser case reproduces the original ordering; the final audit passes
its unchanged repeatability requirement. No writes, deploys or journey reseals
are implied by these UI results. Remaining work stays in the canonical TODO.
