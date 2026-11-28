# Deck tour film

`scripts/demo/deck-tour-film.mjs` records the deck builder used the way its owner uses it: nothing is typed into a form. Every edit is made by clicking on the slide and editing it in place, or by asking the composer's agent and pressing Apply. It ends with the downloaded PowerPoint file opened and checked. No voice: the voice provider's account is out of credit, so the voice navigator is never started. Built on realtime-modules 0.156.0 and ui-components 2.551.0, where the in-place editor is set in the slide's own font, size and colour.

## What the film shows

Vera Green (org leader) owns the Auth Migration initiative. Each feature gets a caption card drawn by the film (like its cursor).

1. **A sample deck.** From the initiative's Docs tab, the seeded "Auth Migration: steering update" (corporate style). The film steps through its agenda, KPIs over a chart, a section divider and icon cards to show the designed layouts.
2. **Start from a template.** The new-deck page's eight templates; Vera picks Status update.
3. **Edit in place.** She clicks the title on the slide. The editor opens on the title's box in the slide's family, size and colour, and she retitles it to "Auth migration: one login path". Enter saves a new version.
4. **Emphasis.** She selects "one login path". The emphasis bar sits above the box as one row of icon buttons, clear of the text, and Highlight marks the words.
5. **Icons.** She clicks the first card's icon on the process slide. The icon picker opens in the side pane, and the slide redraws with the new icon.
6. **Cards on the slide.** She hovers a card and uses its plus to add a card, then its minus to remove it. No dialog opens.
7. **Graphics.** On the cover she opens Change graphic. The picker's tiles are the artwork itself, drawn in the deck's colours, and she chooses Blob pair.
8. **Styles.** On the process slide she switches the deck style from bold to editorial to playful, and every slide restyles.
9. **Ask the agent.** In Agent mode she types three requests and presses Apply on each proposal card:
   - "put the spend by initiative pie on slide 3" puts a pie from the report on the KPI slide;
   - 'emphasise "comes next" in the title' runs on the selected timeline slide;
   - "switch to the corporate style".
10. **Present.** Both left rails fold and the slide fills the page. The film steps through all seven slides, then Escape returns to the editor.
11. **Download.** The saved version as .pptx.

## The take

- **Length:** 3 minutes 10 seconds at 1440 by 900 (the fourth take; 4 minutes 37 seconds recorded). Each scene plays at 1x for its first 4.5 seconds while its caption is read, and for its last second; the hand at work in between plays at 2.5x, which also squeezes the agent's waits. The sample deck, present mode and the ending play at 1x throughout.
- **All thirteen checks passed:** the sample deck (12 slides); the template deck (6); retitle in place; highlight; icon swap; card add and remove; decoration; three styles; the three agent requests; present (seven positions); and the download. Each edit wrote a version through the operations route (201).
- **The .pptx opens:** a valid zip with 7 slides (6 plus the generated Sources slide) and 7 notes pages. It has 23 native `custGeom` shapes (the icons and arrows drawn as PowerPoint geometry), one native pie chart (spend by initiative) and the highlight as a native `a:highlight` run. It has no `gradFill`: the corporate style paints no gradient shapes (see finding 2).
- **Frames looked at** (twelve, once each):
  - the Docs tab with the opening caption;
  - the sample deck's cover, KPI slide and icon cards;
  - the template deck's cover;
  - the title editor in the slide's own white bold face, with the one-row emphasis bar above it;
  - the process slide with its icon swapped;
  - the card's plus and minus on the slide;
  - the process slide restyled;
  - the KPI slide before and after the pie;
  - the timeline with "comes next" highlighted and the composer's "Gave highlight emphasis" line;
  - the cover back in corporate before Present.

  No dialog anywhere, and no form under the stage.
- **What is still imperfect:**
  - the Present caption appears a beat before the click;
  - the composer stays open over the lower part of the stage after an Apply;
  - present mode ends on the Sources slide, so the download scene shows that slide.

## Defects seen in rehearsal takes and fixed in the script

- "add a kpi slide after the agenda" made a proposal card that cannot be applied ("Slide 3: a 'kpi' slide needs a chart"), and the film waited for a card that never came. The film now puts the report's chart on the template's own KPI slide, and a refused request is a failed check instead of a stall.
- The template caption appeared over the sample deck before the new-deck page opened; it now follows the page.
- Styles were switched on the cover, where bold and corporate look alike; they are switched on the process slide now.
- Gradient emphasis on the corporate cover showed no change on the slide (white text stayed white) and wrote no gradient into the .pptx, so the film uses Highlight.

## Findings in the product (not fixed here)

1. **The deterministic proposer cannot add a KPI or chart slide.** `offlineProposal` turns "add a kpi slide after the agenda" into one `add_slide`. A new kpi or chart slide needs its chart in the same list, and `set_chart` cannot name a slide that `add_slide` has not created yet. The card says nothing can be applied. Either `add_slide` takes a chart (or a client id that later operations can name), or the proposer adds the slide with a report chart. The longer phrasing "... with the spend by initiative report" is not parsed at all.
2. **Gradient emphasis is invisible on a full-colour cover.** Gradient on a title over the accent background paints plain white in the preview, and the .pptx run gets a solid fill. This is probably a contrast fallback in the engine, but the toolbar still offers Gradient there, and nothing on the slide changes.
3. **The pie on the template's KPI slide sits beside the template's own figures** ("14 of 22", "11%", "2"). Those figures describe the template's route-planner example, not spend. The agent changes the chart only.
4. **Template decks cite the example source on every slide.** "Example sources (every slide)" stays in the things-to-check line, as before.


## How to run it

```
node scripts/demo/deck-tour-film.mjs --out <dir>                 # a take, then <dir>/deck-tour.mp4
node scripts/demo/deck-tour-film.mjs --out <dir> --compose-only  # the edit again from <dir>/timeline.json
node scripts/demo/deck-tour-film.mjs --out <dir> --probe         # no film: each layout's form fields
```

The agent requests go to the mock's deterministic proposer (`offlineProposal` in `middleware/src/lib/deck-shared/propose.ts`), so only its phrasings work: change a slide's layout, add a slide of a layout after another, switch style or theme, remove or move a slide, emphasise quoted words in a title, and put a report's pie, bar or line chart on a slide.

It starts its own mock middleware on 4190 and portal on 5290, refuses to start if either port is taken, and stops only the process groups it started. Bedrock is blocked by dummy keys. The MP4, its frames and the downloads stay in the output folder, outside git.
