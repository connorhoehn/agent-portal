# Distillation — the guide record as something you use (target mockup)

Source: the user's mockup image, 2026-09-24 — **open `docs/distillation-guide-record-mockup.png` with the Read tool and look at it before anything else**; the transcription below is
a checklist, not a substitute. This is the **target** for
`/iq/distillation/knowledge?item=art-010` (and every L2 guide/procedure
record). Where this spec and the image disagree, the image wins; where it is
silent, keep today's behaviour.

## What the image shows, pane by pane (1672×941 desktop)

### Shell + rails — unchanged
Org header ("Org · Mock: aurora, agentcore, guardrails, cloudwatch", Search,
demo-macbook · 1, Demo User · Member). Org rail (PLAN 1 … SYSTEM 1) and the
Distillation sub-nav rail exactly as shipped in `14367dc1` (KNOWLEDGE 3:
Guides & findings 11 selected, Patterns 22, Run notes 109; REVIEW 2: Pending 7,
Reviewed 20; ACTIVITY 2: Runs in red, Tier graph). No change requested here.

### Explorer column (~320px)
- Pane header **"Knowledge"** (18px-ish semibold, same baseline as the rail
  headers) — this *replaces* today's small "Knowledge" label.
- Scope label row: **"GUIDES & FINDINGS"** muted caps on the left, count
  **11** in a pill on the right.
- Search field **"Search guides & findings"** with the **filter icon button
  beside it on the same row**.
- Hint under it: "Searches guides & findings only".
- **No view `Select` dropdown** ("Guides & findings 11" select is gone — the
  rail already chooses the view).
- Groups "RECENTLY UPDATED 4" / "EARLIER THIS WEEK 7" with flat rows:
  title (13px, one line, ellipsis) + "Procedure · Published · 16h". **No row
  icons** (today's rows carry a FileKindMark/branch icon on the left).
  Selected row: pale indigo fill + 2px left accent.

### Content column
- **No separate "Knowledge" H1 row.** The top line of the content pane is the
  breadcrumb **Build › Distillation › Knowledge**; **All repositories** select
  and **Open Library ↗** sit at the right, vertically between the breadcrumb and
  the title.
- Record title is the page's headline: **"Cut one tenant over from SAML to
  Cognito"** (~26px semibold) + **Draft** pill; "Updated 20h ago" under it.
  No kind icon to the left of the title, no "Guides & findings / Procedure"
  crumb above it.
- **Sources 4** button right-aligned on the tabs' row line (above the tab
  underline). **No collapsed right-hand sources strip.**
- Tabs: **Content** (selected) · **History** · **Runs 2**.

### Content tab body — the redesign (plain language, action first)
1. **WHEN THIS HELPS** (muted caps label). Plain-language paragraph for a
   reader deciding whether this applies to them: "Planning to move a
   customer's sign-in to Cognito? Use this guide to plan a gradual switch, keep
   people signed in, and preserve a way to roll back. It brings together steps
   and lessons from an earlier migration."
2. Divider, then **USE IT IN YOUR WORK**: "Tell the agent which project you're
   working on. It can explain the approach or help draft a plan using this
   guide." Buttons: **Draft a plan for my project** (primary, indigo) and
   **Explain this guide** (secondary). Helper under them: "Adds this guide to
   the conversation. You review the plan before doing the work."
3. **Warning callout** (amber, full width, icon left, action right):
   title **"Check the redirect before you use this"**, body "The last attempt
   stopped at step 3 because sign-in still pointed to the old service.",
   action **View run →** (opens the Runs tab / that run). Shown only when the
   latest recorded run failed or was abandoned; it is the ONLY place run
   outcome appears on the Content tab.
4. **THE APPROACH  4 steps**: numbered steps in plain words with neutral
   number badges — **no ✓/!/○ run markers and no red failure note under a
   step** (that moved to the callout and the Runs tab):
   1 Keep the existing sign-in available as a fallback.
   2 Check that active sessions stay signed in.
   3 Switch one customer and verify sign-in.
   4 Restore the previous sign-in if the checks fail.
5. **BASED ON**: one source row — document icon, **"Retire the SAML shim
   tenant by tenant"**, meta "Source pattern · auth-service", chevron ›, opens
   that pattern. (Replaces today's "WHAT THE SOURCE RUN FOUND" paragraph +
   "Pattern: … →" link.)
6. **› Technical details** (collapsed disclosure) — unchanged.

### Composer (bottom of the content column)
Light/white, faint border — **not** the dark particle composer shown today.
Top line: **Agent ▾** at left, **This guide ▾** context chip at right
(dropdown, not an ×-removable chip). Placeholder **"Describe your project or
ask about this guide…"**. Toolbar B · I · link · • · ?; **Ask →** button right.
"Draft a plan for my project" / "Explain this guide" prefill/submit this
composer with the guide attached as context.

## Deltas against today (commit `14367dc1`, `portal/src/pages/distillation/`)
| Area | Today | Target |
|---|---|---|
| Module header | `ScopeHeader` title row "Knowledge" above the panes | breadcrumb + repo/Library controls live at the top of the content pane; no title row |
| Explorer | small "Knowledge" label, view `Select`, filter on its own | pane title "Knowledge", scope label + count, search+filter row, no select, no row icons |
| Record header | crumb "Guides & findings / Procedure", kind icon, title | title + Draft + updated; Sources N on the tab row |
| Right strip | collapsed Sources strip with badge | none (Sources opens from the button) |
| Body | summary prose, WHAT TO DO with run markers, WHAT THE SOURCE RUN FOUND | WHEN THIS HELPS, USE IT IN YOUR WORK, run warning callout, THE APPROACH, BASED ON |
| Composer | dark particle, "Explain when I should use this…", ×-chip | light, "Describe your project or ask about this guide…", This guide ▾ |

## Rules (from the user, non-negotiable)
- No hand-rolled UI. Every primitive comes from `@connorhoehnslalom/ui-components`
  (and hooks from realtime-modules). If a primitive is missing (e.g. a callout
  with trailing action, a scope label row with count, a light composer
  variant, a source row), add it to ui-components first, release it, pin it.
- realtime-examples is the reference for how the library's composites are
  used in a real app (its chat / document / agent-run use cases); reuse those
  patterns rather than inventing page-local ones.
- The plain-language copy is DATA, not literals: "When this helps", the plain
  approach steps and the run warning must come from the record (server) —
  mock fixtures included (`docs/mock-floor.md` rules apply).
