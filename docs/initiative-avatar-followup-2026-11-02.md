# Initiative portrait follow-up

The reported LLM Platform Overview had two mappings that discarded portraits:
the attention/up-next model retained only assignee names, and Recent activity
retained only its participant's name. The Work table already carried portraits.

Overview now resolves contributor photos by person id. Recent activity preserves
participant ids and optional snapshot portraits, then uses the host's authorized
contributor data when the snapshot has no image. Unknown identities and genuinely
missing photos keep initials; namesakes never supply another person's image.

The generic `demo-user` session was outside the seeded portrait cast and has no
directory person. It now has its own synthetic portrait, carried through the
shared directory's self record and the signed realtime token. The identity and
permission rules are unchanged. Reload an existing browser session to acquire a
fresh realtime token and reconnect presence.

Generated with the built-in imagegen tool in one request:

- Asset: `portal/public/avatars/photos/demo-user.jpg` (256px JPEG).
- Prompt: `scripts/avatars/prompts/2026-11-02-demo-user.txt`.
- Source hash and processing notes: the Demo User entry in
  `portal/public/avatars/photos/personas.json`.
- The generator and fixture now cover 72 identities: 59 people, 12 unlinked
  accounts and the generic demo session. Existing portraits are unchanged.

## Verification

Evidence is in `.scratch/initiative-avatars-2026-11-02/`:

- 33 focused portal tests and 23 middleware tests pass.
- Portal/middleware type checks, portal build, avatar-index validation and
  component-discipline checks pass.
- Two live browser cases verify loaded images in both themes on LLM Platform
  and Observability: overview rows, Recent activity, Work table, generic demo
  presence and the missing-photo fallback. Business writes were blocked.
- Screenshots were visually checked. No shared component API or styling changed.

The full portal suite still reports one unrelated Assessment navigation test
failure (`nav model: rail, palette and trail say Communication` expects
`Assess / Communication`; the concurrent breadcrumb edit emits `Communication`).
Those Assessment edits are outside this avatar commit and were left untouched.
Existing audit and deployed-avatar backfill debt remains in the earlier handoffs.

## Collection and cross-tenant audit follow-up

The All initiatives table still received owner/SME names without their IDs or
portraits. Its API now carries an identified `team` collection in both mock and
Aurora modes. The real provider reads portraits once for the returned IDs, and
an absent avatar column leaves the work/budget rollups intact. AvatarGroup uses
those URLs rather than selecting a face by name. The Spend (MTD) heading is
left-aligned; values, empty indicators and locked figures share a right edge.

The wider audit found and repaired three other dropped portrait paths:

- Decision participants retain their portrait through the activity projection,
  including signers outside an initiative's contributor roster.
- Design posts and sign-offs capture the signed author's portrait; the route
  ignores a portrait supplied in the request body. Explicit missing portraits
  and conflicting same-name snapshots stay unknown. Legacy name-only records
  use a contributor photo only when the match is unambiguous.
- Assessment contributor JSON carries an optional presentation-only avatar URL.
  This adds no directory identity, membership or grant. The cloned test identity
  also retains its registered source account's portrait, and directory cards
  use the authorized person response's URL.

Eight synthetic Assessment portraits were generated in **one imagegen request**
as a 4-by-2 grid, then cropped to 256px JPEGs. The eight `assessment-*.jpg` files
are under `portal/public/avatars/photos/`. The exact prompt is
`scripts/avatars/prompts/2026-11-02-assessment-grid.txt`; source hash and crop
coordinates are in `photos/personas.json`. The manifest/generator now covers
80 identities (59 directory people, 12 unlinked accounts, one demo account and
eight Assessment contributors). Existing faces are unchanged.

Up next now uses the same two-line row composition as Recent activity: title
first, item key underneath in muted monospace. Both lists reserve the same
person and trailing-fact widths, so the titles and 24px portraits align across
sections. These changes compose existing shared APIs; no library fork or new
component API is required.

### Verification

Evidence is retained in `.scratch/avatar-audit-2026-11-02/`:

- The data-specific portrait audit covers 73 routes: 62 OrgIQ routes, three
  Assessment routes, four Social routes, one Pipelines route and three Admin
  routes. This includes all 14 initiatives' Overview, Work and Contributors
  tabs plus every seeded design thread. It checks 539 known-person avatar
  instances; all load. The one intentional non-human fallback is `#general`.
- All initiatives verifies each row against API team IDs/URLs and measures
  Spend alignment in light/dark. Four Overview cases verify the title/key order,
  title edges, matching avatar columns, loaded photographs, presence and the
  genuine missing-photo fallback in light/dark at 1440/900px.
- The shared strict UI audit covers the Initiatives list in both themes at
  1440/900px: four cases, zero findings and no unclassified composer policies.
- 87 focused middleware tests and 15 portal tests pass, including same-name
  isolation, old-schema fallback, projection preservation and session-derived
  portraits. Middleware/portal type checks, portal production build, avatar
  manifest validation and the component-discipline gate pass.
- Screenshots were visually reviewed. Browser checks block business writes;
  no work items, design answers/sign-offs, calls or AWS resources were changed.

`verified/` retains the full portrait pass. The later `final-browser/` run passes
all six layout/portrait cases; its broad audit records six unloaded SOC2 avatars
during a local Vite restart (the trace contains `ERR_CONNECTION_RESET` and
`ERR_CONNECTION_REFUSED` for those image requests). The exact Contributors route
was rechecked in `soc2-confirmed/`: all six portraits load. Failed evidence is
retained alongside the confirming run, rather than removed from coverage.

This is a rendered portrait/data audit, not an assertion that every application
interaction or live production record has been verified.

### Needs attention alignment

The attention row now shares the title/subline and trailing-column layout of
Up next and Recent activity. Its leading key/status badges and accent bar are
removed; the key, red Blocked label and reason sit below the title. The full
reason remains available on hover when the narrow layout truncates it. The
warning surface remains, and the same chevron as the other sections keeps the
avatar/points columns aligned. Clicking anywhere in the row still opens the item.

Evidence: `.scratch/attention-alignment-2026-11-02/`. Browser checks compare title,
subline and avatar edges across all three sections at 1440/900px in light/dark,
verify the preserved reason, and open the blocked item's Work view. The portal
type check and component-discipline gate pass. A strict shared-UI sweep of the
Auth Migration Overview also passes all four theme/width cases with zero findings
and no unclassified composer policies. Existing shared primitives cover
this composition; no package release or new technical debt is introduced.

### Remaining technical debt

- **PEOPLE-03 remains open for deployment.** Seeded Aurora `people.avatar_url`
  and unlinked `app_users.avatar_url` still need the canonical-ID backfill and
  deployed asset verification described in `ui-document-reading-2026-11-01.md`.
  Existing Assessment contributor JSON also needs explicit portrait URLs when
  deployed; its JSONB column requires no schema migration for this addition.
- **Legacy design identity.** Snapshot portraits fix rendering, but older design
  authors, participant grouping and sign-off deduplication still use names.
  Persist canonical author IDs before resolving those records more broadly;
  a missing portrait must never borrow a namesake's face.
- **Coverage.** The new audit covers known fixture people on enumerated routes;
  it does not certify every disclosure, live data source or newly created user.
  People with no supplied photograph legitimately retain initials.
- The existing large-bundle warning, document/focus/contrast audit debt and
  stale journey seals remain open in their respective handoffs.
