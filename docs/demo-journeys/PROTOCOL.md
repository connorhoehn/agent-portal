# Journey protocol — the demo stories

One log per tenant story under `docs/demo-journeys/<tenant>/<story>.md`,
written by `node scripts/journeys/run-maps.mjs walk --family demo` from the
maps in `docs/journeys/maps/demo/`. The goal is `docs/demo-content-goal.md`;
the audit that chose each story is `docs/demo-content-audit.md`.

A story map is a content walk, not a layout walk: each step opens a page of
the story (or follows a link the story names) and asserts

- **story-facts** — the facts a peer must see are on screen (the cast by name,
  the record the story is about, the blocker and who can lift it), and none of
  the leaks the rubric bans are (raw ids and slugs, ISO stamps, template
  filler, developer copy — `LEAKS` in `docs/journeys/maps/demo/_shared.ts`);
- **cross-links** — a record the story names leads to its own page, or a page
  that follows from the last one agrees with it.

Walk as clones (`openAsClone`), read-only, on the shared `dev:mock` world —
never as the seed personas and never in the user's Chrome. A story whose
records a clone cannot see (rows keyed by the seed user's id) fails: the demo
must not depend on one identity. The layout judges own the DOM audit, so every
page step carries `audit: false` with that reason.

| log | persona (cloned) | role |
|---|---|---|
| `orgiq/story` | `u-vera` Vera Green | org-leader |
| `orgiq/budget` | `u-mia` Mia Singh | program-owner |
| `assessment/story` | `u-jonas` Jonas Lindqvist | lead-assessor |
| `social/story` | `u-sana` Sana Iqbal | participant |
| `pipelines/story` | `u-kofi` Kofi Mensah | operator |
| `access/requester` | `u-rhea` Rhea Castellanos | requester |
| `access/approver` | `u-omar` Omar Haddad | approver |
| `access/admin` | `u-priya` Priya Venkataraman | access-admin |

Log fields (the `story` kind in `scripts/journeys/maps.mjs`): surface, role,
user, url, map, pages, audited, session, screenshot, verdict, console errors,
layout, story-facts, cross-links, dom-audit, notes. A log counts only with
`verdict: pass`, `story-facts: pass` and `cross-links: pass`.
