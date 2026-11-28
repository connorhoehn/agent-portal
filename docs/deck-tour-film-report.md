# Deck tour film

`scripts/demo/deck-tour-film.mjs` records a person building a fifteen-slide steering deck by hand in the deck builder, one feature after another, and ends with the downloaded PowerPoint file opened and counted. No voice: the voice provider's account is out of credit, so the voice navigator is never started.

## What the film shows

Vera Green (org leader) owns the Auth Migration initiative and builds its December steering review. Each feature gets a caption card drawn by the film (like its cursor), placed beside the slide stage so it does not cover the form or the toolbar.

1. **New presentation.** The five example decks, then "From this initiative's facts": a title, Build deck. Eight slides arrive, built from the initiative record (work items, story points, sprints, budget, decisions).
2. **Things to check before sharing.** The line above the editor says slide 1 overflows; its thumbnail carries the warning marker. Vera fixes it (see the first finding) and the overflow leaves the line.
3. **The layout gallery, in place.** Insert, then All layouts. Seven slides are added from it: an agenda, key figures (16 of 31 points done, $66.93 budget left, 1 decision escalated), a stacked bar chart (open and done work by type: 9 items, 6 open), a table of the two sprints, a comparison of the escalated cutover decision with a verdict, a three-step timeline, and a closing slide with the ask. The agenda is typed key by key with the pinned stage redrawing beside it; the remaining fields of later slides are filled at once, and those spans play at 2.5x in the edit.
4. **Slide menu.** The bullet slide the table replaces is deleted from its menu. The key figures slide moves up from its menu ("lead with the numbers").
5. **Speaker notes** on the comparison slide.
6. **Save**, then **Fill from a report**: a new chart slide gets "Spend by initiative, the last 30 days" as a pie, run under Vera's own access. The report renames the slide.
7. **Theme** (Work to Engineering), **undo** and **redo**, save.
8. **Version history**: v1 (the deck as the facts built it, 9 slides) and back to the newest.
9. **Present**: both left rails fold and the slide fills the page with its speaker notes beside it; no dialog. Six slides, then Escape.
10. **Download** as PowerPoint and as PDF.

Share is not shown: a deck with budget figures cannot be shared to a channel, and the page says so in a notice above the findings line. That is the product's rule, not a defect.

## The take

- **Length:** 3 minutes 58 seconds at 1440 by 900 (the fifth take; 6 minutes recorded). Each scene plays at 1x for its first 4.5 seconds, while its caption is read, and for its last second; the hand at work in between plays at 2.5x. The opening, the examples, present mode and the ending play at 1x throughout.
- **All ten checks passed:** built from facts (8 slides), overflow fixed, reordered, saved, pie from the report, theme with undo and redo, version history (v1 has 9 slides including the generated Sources slide, the newest 16), present (seven positions), both downloads.
- **The .pptx opens:** a valid zip with 16 slides (15 authored plus the generated Sources slide), 16 notes pages, and three native charts: a clustered bar (work by status, from the facts), a stacked bar (open and done work by type) and a pie (spend by initiative). The comparison slide's notes page carries Vera's speaker note. Layouts in order: title, agenda, key figures, bullets, chart, chart (stacked bar), bullets, table, bullets, chart (pie), bullets, bullets, comparison, timeline, closing, sources. The PDF starts with `%PDF`.
- **Frames looked at** (twelve, once each): the initiative's Docs tab with the opening caption; the editor with "Overflow (slide 1)" and the caption beside the stage; the fix under the Bullets layout; the stacked chart scene; the comparison with its speaker note; the theme switched to Engineering (dark slides); the version scene; the ending. No placeholder slide in the final deck, no clipped control, no dialog anywhere.
- **What is still imperfect:** a few holds of 3 to 4.7 seconds where only the caption changes (the examples, saving, the report panel); a scene's caption sometimes appears a beat before its slide is added; the "Where the money goes" chart shows its empty default data for a few seconds before the report fills it; the film ends on slide 7 (where present mode stopped) rather than on the title.

## Defects seen in rehearsal takes and fixed in the script

- The take was 10 minutes long. The film waited up to 20 seconds after every edit for the stage image's natural width, which an SVG stage never reports; the wait is now "the image is complete", bounded at 4 seconds. Theme, undo and redo were detected by a change of the stage's image address, which a theme change does not make; they are now read from the toolbar's Theme label. Version history now waits on the slide count, not the stage address.
- The toolbar no longer has a "⋯" menu; All layouts is the last row of Insert. Both this film and `deck-voice-film.mjs` (whose rehearsal stopped at its seventh scene for this reason) now open the gallery through Insert (the voice film's rehearsal was not run again after this one-line change).
- Caption cards first sat over the slide position control and, in the version scene, over the open versions menu; they now sit lower beside the stage, and the version scene's caption sits bottom left.
- The cursor rested on Exit presentation during present mode; it now moves off the slide.
- The expanded findings list pushed the form below the fold; it is folded again after the fix.

## Findings in the product (not fixed here)

1. **The title layout's form cannot edit the lines the facts build puts on the title slide.** A deck built from the facts has five standfirst lines on slide 1 (status, owner, sponsor, repository, as-of date) and opens with one thing to check: "Slide 1 (title) standfirst: 5 lines need 166pt of a 115.2pt region; bullet 4 is the first to cross." The Title layout's form shows only the eyebrow, the title and the sources, so the overflow cannot be fixed there. The film switches the slide to the Bullets layout, removes the repository and as-of lines, and switches back to Title, which works but is not something a person would guess. Either the facts build should write at most what the title slide holds, or the Title form should show its standfirst.
2. **A report's chart keeps the old slide's bullets, and the Chart form cannot remove them.** Filling the "Sprint envelopes" bullet slide with the spend pie produced "Overflow (slide 10)": the three long envelope lines stay beside the pie, and the Chart form lists only the title, the chart type and the data. The film puts the pie on a new chart slide instead.
3. **Slides added in the editor cannot cite the initiative record.** Each new slide cites the placeholder example source, so the finished deck still has "Example sources (slides …)" in its things to check. The source search on those slides answers "Nothing matches that. Sources come from the Documents explorer", so the initiative record that the facts slides cite is not offered.
4. **Raw values on the facts deck.** The deck's subtitle reads "In Progress · as of 2026-11-28" (an ISO date), and the title slide lists "Repository:" with the repository's owner and name.
5. **The stage is small at 1440 by 900** (about 450 pixels wide beside the filmstrip), already queued in the component queue.

## How to run it

```
node scripts/demo/deck-tour-film.mjs --out <dir>                 # a take, then <dir>/deck-tour.mp4
node scripts/demo/deck-tour-film.mjs --out <dir> --compose-only  # the edit again from <dir>/timeline.json
node scripts/demo/deck-tour-film.mjs --out <dir> --probe         # no film: each layout's form fields
```

It starts its own mock middleware on 4190 and portal on 5290, refuses to start if either port is taken, and stops only the process groups it started. Bedrock is blocked by dummy keys. The MP4, its frames and the downloads stay in the output folder, outside git.
