# Table-density audit — 2026-09-16

**Lens.** Does every table earn its columns, and is the most important fact
first? The standing preference this measures against: a list page shows its
table above the fold, with one compact selector row and no stack of status
cards pushing content down. The reference shape is the local-compute page,
rebuilt the same day: identity first, live state in the middle, one trailing
actions column, and a tabbed detail area instead of stacked sections.

Covered every `DataTable` call site and every hand-rolled `Table` composition
in both tenants, checked against the mock fixtures so that "this column never
varies" could be told apart from "these seed rows happen to agree".

## What was found

**Identity was not first on sixteen tables.** They led with a timestamp or a
status chip and put the name that tells rows apart second or third. A queue is
scanned by *which* thing this is and only then by what state it is in, so a
column of near-identical pills sat where the identifying text belonged. The
worst case was the failed-jobs table, whose leading Status column restated its
own section heading — that table is filtered to failed and cancelled, so every
chip read the same.

**Four columns never varied.** A bot's trigger is `cron` on every seeded row
and every row the schema writes; the knowledge-base registry's tenant column
had one value and a filter above it offering the same one; the feedback status
column repeated the filter the page defaults to. Each spent width to say
nothing.

**Four cells said something twice**, including a bot's daily spend rendered as
text and again as a bar in the same row, and a boolean rendered as both a chip
and the switch beside it.

**Two cells were unguarded** and could run to any height: a denied-topic
definition and a tool-call error message, neither truncated.

**One operation, five words.** Opening a row was "Open", lowercase "view",
"view A"/"view B", a bare arrow glyph, and an unlabelled row click. Removal
was both "Delete" and "Remove". One actions column was headed "Status".

**Decoration above the fold.** Several pages put a stat strip or a card grid
above their table carrying no number the table lacked.

## Resolution

Identity leads on all sixteen. The restating Status column is gone rather than
moved. The dead columns are deleted with their constant folded into the
section header, so the fact survives without a column. Duplicates collapsed to
whichever rendering carried more — the bar over the number, the switch over
the chip. The two unguarded cells truncate with the full text still reachable.
Navigation is "Open" and removal is "Delete", everywhere.

One deletion went too far and was corrected: dropping the feedback status
column is right under the default filter, where every row is open, and wrong
under "all statuses", where rows genuinely differ. It is conditional now —
present exactly when the rows can disagree.

The distillation overview kept its strip after checking: its "proven
procedures" figure is a rollup across all procedures while the table shows the
first six, so it is a total the table cannot carry.

## Still open

Three surfaces would benefit from the full local-compute treatment. Bots is
being done now. The capability-session pages stack three near-identical
session tables behind several blocks of preamble. And the agent fleet has no
list view at all — eight agents reachable only through a diagram, which cannot
be scanned down a column.
