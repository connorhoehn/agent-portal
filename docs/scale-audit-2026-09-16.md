# Behaviour-at-scale audit — 2026-09-16

**Lens.** Every surface here was built against a seeded demo corpus of tens of
rows. What does it do at ten times that? Two questions per surface: does the
server bound what it returns, and does the client bound what it renders.

## The finding that is a bug today, not at scale

`GET /api/work/summary` built its "open findings" figure by asking for findings
with `limit: 300` and then counting the array it got back. Past three hundred
open findings the number is simply wrong, and wrong in the worst way — it looks
authoritative and it under-reports, so the queue appears calmer than it is. A
real aggregate (`findingStats()`, a `GROUP BY`) already existed and was already
used correctly by the neighbouring `/findings/stats` route.

The same shape appeared in the scores leaderboard (`total` was the page length,
not the population) and in the knowledge-base document totals. A count derived
from a capped list is not a count.

## What breaks first as data grows

- **The org graph, unbounded at both ends.** The people query had no `WHERE` and
  no `LIMIT`, its edge derivation is quadratic, and the page rendered every node
  the server sent with viewport culling switched off.
- **The assessment tenant had no pagination at all** — not one table passed a
  page size, and the roster route took no parameters.
- **Hand-rolled tables with no lever**: several observability tables and the bot
  run history had neither a server limit nor a client bound.
- **Two heavy re-renders**: the local-compute run log rebuilt its whole line
  array on every poll, and handed every line to a component that makes each one
  a DOM node.

## What was already right

The invocation search clamps to 500 and proves it under a `?limit=10000` probe;
distillation's item route rejects an out-of-range limit with a 400 rather than
silently clamping; the bots routes hardcode their caps; the local-compute log
buffer is bounded by bytes and by a job LRU; the assessment event stream keeps a
ring buffer. The radial org-chart layout is bucket placement, not a physics
simulation, so it is not the risk the rendering is.

## Resolution

Counts now come from aggregates. Unbounded reads take a clamped limit and report
a true total alongside the page. The client caps what it paints and — this is the
point of the pass — **says so whenever it truncates**, through one shared
`showingLabel(shown, total, noun)` helper. Silent truncation is worse than
slowness, because the reader cannot tell it happened.

## A gap this audit found in its own instrument

`GET /api/__mock/scenarios` advertises a `large` scenario, "a high-volume corpus
for pagination, truncation and density". **No fixture implements it.** Applying
it returns 200 and changes nothing, because every fixture falls back to
`default` for an undeclared scenario — the same silent fallback the `empty`
branch on `agent-projects` was fixed for in September. So the truncation paths
this pass added cannot be exercised end to end from the mock, and any
measurement attributed to "the large scenario" is really a measurement of the
default corpus. Queued: implement `large` for the fixtures where truncation
actually matters, or stop advertising a scenario that does nothing.
