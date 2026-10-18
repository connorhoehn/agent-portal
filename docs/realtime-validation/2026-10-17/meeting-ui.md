# Initiative meeting UI acceptance — 2026-10-17

Scope: initiative huddles behind `VITE_MEETING_ROOMS`, with ui-components
**2.480.3** (upstream `3a319328`) and realtime-modules **0.137.0**. The local
portal ran on `127.0.0.1:5184`, against the existing BFF on `:3001`.

The strict ui-dom-audit passed **20/20 cases**, with **0 findings** and **0
unclassified controls**. This includes the call open with its Rooms pane at
1440 and 900 pixels, in light and dark themes. The saved
[Rooms proof](meeting-ui-audit.json) includes the source digest, contract hash,
all four cases' findings and coverage, and the Rooms measurement samples.
The full local report is `.scratch/ui-dom-audit-call-rooms-accepted/report.json`.

The audit now handles prejoin, retains all three clone participants through
measurement, reaches Rooms through More at narrow widths, and cleans up the
call afterward. The media fixture is shared with E1; gateway membership,
meeting actions and announcements still use the real local BFF. Actual SFU
media admission and room moves remain covered by the separate
[2026-10-16 real-media acceptance](../2026-10-16/meeting-breakout.md); that test
was not rerun for this UI follow-up.

Both 27-step meeting journeys passed with zero unexpected console errors and
were sealed against the refreshed contracts:
[organizer](../../work-journeys/org-leader/call-rooms.md) and
[participant](../../work-journeys/sme/call-rooms.md). The other 123 existing
journey seals were preserved. `scripts/meeting-rooms-proof.mjs` now makes the
meeting validator require this current strict audit and both passing, sealed
walks; file existence alone is insufficient.

Changes found by the checks:

- Shared count badges use 12px text. The icon-centering audit excludes only
  an explicitly marked, absolutely positioned count overlay from the inline
  label baseline; ordinary labels remain checked. Upstream audit mutations
  cover both cases.
- Org light-theme accent, tertiary text and danger colors pass contrast on
  the measured surfaces. Semantic foreground tokens are defined in both themes.
- Breakout chat offers no REST slash commands and does not poll agent approvals:
  those routes accept the main huddle, not the gateway-only room channel.
- Meeting journey maps use three clone identities. Vera is the organizer;
  Caleb is the participant without initiative stewardship. The runner blocks
  HTTP business writes and can seal only the logs it actually walked.

Checks completed on this source:

- The full `scripts/validate-meeting-rooms-app.sh` returned **ALL CHECKS PASS**
  with `VITE_MEETING_ROOMS=true` and `PARITY_BASE_URL=http://127.0.0.1:5184`:
  static gates, middleware typecheck and gateway/lobby-access tests, portal
  typecheck/unit tests, E1, and the current E3 proof.

- Portal production build and all **1,777** unit tests passed.
- E1 passed in light and dark. It checks the huddle thread in either its side
  pane or initiative-composer placement, then verifies return to the main call.
- All **26** journey-runner and proof tests passed, including rejection of
  stale or incomplete audit proof and unrelated console failures.
- Rendered contracts refreshed: all 19 rail routes, 18 layout tests covering
  143 routes, and six type-scale tests passed. The rendered contract values
  are unchanged; their source digest and measurement times were refreshed.
- Upstream ui-components: build, lint, packaging/export checks, **11,206**
  passing unit tests (two skipped), and the audit self-test passed.

A startup 404 is expected only for the call's initial `GET /page` and `GET
/chat` reads before gateway registration; the controllers retry them. Journey
logs retain these errors, and the matcher includes the exact status and path.
Other failures still fail the walk. The unsupported breakout approval poll
was fixed rather than classified as expected.

The separate branding follow-up now passes the full validator. Its static
padding check uses the current `data-subnav-content` marker and verifies the
reset value. All four branding journeys were re-walked and sealed: eight
surfaces per tenant/theme, 16px title spacing, zero console errors, measured
Card surfaces, and primary-button contrast from 6.29:1 to 9.59:1. The records
now name every sampled route and include separate Card screenshots. No product
source or dependency pin changed in this follow-up. The optional
realtime-examples rail comparison was skipped because that server was not
running on `:15174`.
