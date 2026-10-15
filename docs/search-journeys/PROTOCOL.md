# Journey protocol — user search

One log per mapped catalog intent under `docs/search-journeys/<tenant>/<role>-<intent>.md`,
written by `node scripts/journeys/run-maps.mjs walk --family search` from the
maps in `docs/journeys/maps/search/<tenant>/<role>/<intent>.ts`. The goal is
`docs/user-search-goal.md` (judge 5); the intents are
`portal/e2e/user-search-catalog.ts` (`map: true`, five per tenant).

A search map is a content walk: the person asks the catalog's question where
they would (the Work search, a list page's search box or command composer, the
command palette) and the walk asserts

- **answers-question** — the answer is on screen: the record or person the
  catalog's seed answer names is visible after the question;
- **record-open** — the record the answer names opens in at most two clicks,
  asserted with the page's URL (`expect.url`).

Walk as clones (`openAsClone`, `identity: 'clone'`), read-only, on the shared
`dev:mock` world (`scenario: 'shared'`) — never as the seed personas and never
in the user's Chrome. "My / me" questions resolve through
`middleware/src/lib/record-owner.ts`, so a clone asks as its persona. A map
whose surface does not exist yet carries `hold` naming the phase that brings it
(S2 tenant search, S3 palette records); the judge lists those as pending, and
a held map is walked once the hold is removed. The layout judges own the DOM
audit, so every step carries `audit: false` with that reason.

Log fields (the `intent` kind in `scripts/journeys/maps.mjs`): surface, role,
user, url, map, pages, audited, session, screenshot, verdict, console errors,
layout, answers-question, record-open, dom-audit, notes. A log counts only with
`verdict: pass`, `answers-question: pass` and `record-open: pass`.
