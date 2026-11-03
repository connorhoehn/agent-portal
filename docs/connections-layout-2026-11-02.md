# Connections layout — 2026-11-02

Opening `/iq/search?tab=connections&selection=person%3Ap-042` previously put a
second detail column inside the graph, with an expansion toolbar above the
person card. The page also repeated the person's role and exposed both a generic
Ask button and a person-specific Ask action. Graph configuration consumed two
large control rows, while a disabled call action sat above the composer.

The selected person now opens directly in the existing shell `SidePane`. The
graph keeps its own canvas, and the left rails fold using the existing dialogue
layout policy. Closing the inspector retains the selection and survives reload;
View person reopens it. Legacy `detail` and selection URLs remain supported.

Relationships (All, Hierarchy, Skills, Projects) and teams are compact dropdown
facets. Force/Radial is a connected radio group beside the graph. Connections
per person (Top K), minimum strength and the HR-only rare-skills control live in
Graph settings. The large department chips and duplicate canvas legend are gone.
The team facet retains access to those selections. Neighbors in the focused
graph stay readable instead of fading as though they were unrelated. Named relationship lenses
still include all recorded strengths, with an explanation in settings.

The ordinary profile shows its title/department once, separates profile sections
with rules, and has one content-sized Ask action. Asking prepares the contextual
draft and switches the same inspector to its conversation; it does not send.
Multiple selected people retain their separate group-question action. The
Connections composer no longer adds a second Start call/Message row; shared call
and active-huddle controls remain available through the shell.

## Design and ownership

A preview proposal was generated with the built-in imagegen tool and shown in
the conversation. Its compact controls, single inspector and settings disclosure
guided this implementation. The actual app retains the existing navigation,
graph renderer and verified portrait data; generated mockup people are not data
assets. No library fork, private CSS override or package bump was needed.

The page composes the installed `SidePane`, `Select`, `SegmentedControl`,
`FilterPopover`, `Slider` and `OrgGraph`. `DirectoryPersonCard` suppresses its
redundant close action when embedded in the shell inspector and omits biography
text that merely repeats the title/department. HR analytics remain gated as
before. Nothing changes backend permissions or inference policy.

## Verification

- Ten local Chromium tests pass: both themes at 1440/900px, bounded toolbar
  height, nodes inside the canvas, inspector close/reopen/reload, settings
  keyboard interaction, relationship filtering, Force/Radial URL persistence,
  graph exploration, legacy links, initiative scope and single/multiple-person
  Ask context, plus the shared profile's initiative inspector. Tests use
  isolated cloned identities; the layout matrix blocks
  business writes, and no test sends the prepared question.
- The targeted DOM audit passes 16 states with zero findings and zero
  unclassified composer policies: default, person inspector, graph settings
  and relationship facet in each theme/width pair.
- Portal typecheck, UI inheritance and component discipline checks pass.
  No ratchet or contrast threshold was relaxed. The first visual review caught
  full-width Select defaults; explicit intrinsic widths and a height assertion
  now guard that regression. The initial accent radio variant failed dark-theme
  contrast, so this view uses the standard neutral variant.

Evidence is under `.scratch/connections-redesign/`, including `accepted/`
and `accepted-audit/`. Earlier attempts are retained separately.
The shared working tree includes independently owned Assessment/huddle edits;
these checks describe the local tree, not a clean-checkout certification.

The older journey seals remained historical after this redesign; no existing
journey digest was overwritten without a fresh walk. Closed since: the five
Search journeys (every Work role) were re-walked on the 2.500.1 pin and sealed
on freshly measured contracts, the layout-cascade rail-collapse case now
describes this inspector contract (a selected person opens in the shell pane,
so the primary rail folds; closing it returns the depth), and the library
integration debt below is resolved. Nothing in this document remains open as
of 2026-11-03; later Work-tenant items live in `work-social-ui-todo.md`. All
work stayed local; AWS checks and deployment are excluded.

Shared-library follow-up: the accent SegmentedControl variant measured 4.13:1
for its selected label in the dark theme (and 4.04:1 in light: `text-primary`
on `bg-primary-bg`). This page uses the neutral variant; the failing evidence
remains in `audit/`; no theme token was overridden here.

Resolved later the same day in ui-components `260e75d6` (2.500.1): the chosen
accent segment now takes the fill's own foreground token, `text-primary-fg`,
which measures 7.30:1 dark / 4.55:1 light; a library test pins the class pair
and no `@theme` token changed. The app pin moved to 2.500.1 (built from a clean
archive of that commit; it also ships the audit skill). On that pin the ten
Connections specs pass again and the targeted audit passes 16 states with zero
findings in both themes (`pin-2.500.1-audit/`). Consumer sweep: the app's other
accent segmented controls (`useChatPins.tsx`, `FileCards.tsx`) are icon-only,
so they were never below the 3:1 graphic floor; they inherit the fix.
