# Deck spike: one layout, three painters

A throwaway prototype built to settle the first two "Not verified" items in `docs/deck-builder-plan.md` and to test its decision 3 (lay out once, paint three times). It took the existing `DeckSpec` shape and palettes from realtime-modules `src/deck/`, wrote a new `layout()` over real font metrics, and painted the result to PowerPoint, SVG/PNG and PDF. Spike date: 27 November 2026. The prototype lives outside every repository; it is called "the spike's prototype" below.

## Verdicts

1. **One layout, three painters: the model holds.** Title, bullets, two-column, chart and a Sources table are each written once; the three painters switch only on element kind (text, rectangle, line, polyline, circle, chart, table) and never on the slide layout. The scene had to carry more than expected: each text box needs both its unbroken paragraphs (for editable PowerPoint) and its line breaks with baselines (for SVG and PDF), and charts and tables need both their data (for native PowerPoint objects) and their drawn parts.
2. **PDF from pure JavaScript: yes, with pdfkit 0.21.0.** It produced vector PDFs with selectable text in reading order, embedded subset fonts, a bookmark per slide, working links and vector charts, at about 1 to 3 ms per slide and 29 to 35 KB per deck. The only defect found is that letter-spaced text extracts as spaced-out letters.
3. **Font pairs: Arial with Liberation Sans is proven identical; Calibri with Carlito could not be checked here.** Liberation Sans matched the real Arial on this Mac exactly: 0% width difference on all 50 strings and identical advance widths for every printable ASCII character. Calibri is not installed on this Mac, so Carlito was measured but not compared.
4. **Raster output: correct, if the fonts are on disk and passed explicitly.** resvg drew every probed line within 0.81 px of where the scene said its ink would be, at 1920 wide. If the SVG names a family that resvg was not given, resvg does not fall back: the Node process is killed (exit 137).
5. **Painter agreement: the SVG-derived PNG and the PDF agree; the PowerPoint file was not checked by any renderer.** LibreOffice is not installed. Comparing the resvg PNG with a pdftoppm rasterisation of the PDF, at most 0.43% of pixels differ once antialiasing is ignored (5.4% counting antialiased edges), and the differences are glyph edges only, with no moved text.
6. **Text fitting with real metrics works and reports honestly.** Titles shrink through fixed steps, then wrap to two lines; bullets keep 18 pt, wrap, and report overflow. On the long-text deck it reported four body overflows (up to 113 pt past the region) and four titles wrapped at the last step, and nothing was shrunk silently.

## Evidence

### Setup

- Libraries, all from the public npm registry: pdfkit 0.21.0 (MIT), fontkit 3.0.0 (MIT), pptxgenjs 4.0.1 (MIT), @resvg/resvg-js 2.6.2 (MPL-2.0), pngjs 7.0.0 (MIT), pixelmatch 5.3.0 (ISC). Install sizes: pdfkit 4.7 MB, resvg 3.4 MB, pptxgenjs 2.5 MB, fontkit 1.0 MB.
- Fonts: Carlito 1.104 from the google/fonts repository (SIL Open Font License 1.1, Reserved Font Name "Carlito"); Liberation Sans 2.1.5 from the official liberationfonts release (SIL Open Font License 1.1, Reserved Font Name "Liberation"). Regular, bold and italic of both come to 3.1 MB. `@fontsource/carlito` 5.3.0 (OFL 1.1) also exists on npm and has the same version and identical advance widths, but it ships only WOFF/WOFF2 split by script subset, which resvg cannot load; it suits the browser, not the painters. There is no `@fontsource/liberation-sans`.
- Test decks: a short deck (5 slides with the Sources slide, Carlito), a long-text deck (6 slides: 120-character titles, 8 bullets of 200 characters, a two-column slide of 4 x 200 characters per side, a chart with a two-bullet caption), and a chart deck (4 slides, Liberation Sans: 12 labels by 3 series as bars and as lines).
- Units: the scene is in points on a 960 x 540 stage (13.333 x 7.5 in, the geometry in `theme.ts`). The SVG uses points as user units, so a 28 pt title is 28 in every painter.

### 1. The layout model

- `layout(spec, theme, fonts)` returns `{ scenes, findings }`. Layout code is about 230 lines; the three painters together about 120. Adding the Sources table needed no painter change beyond a `table` case in each.
- What the scene needed that the plan does not list:
  - **Two forms of every paragraph.** The PowerPoint painter passes the paragraph unbroken so the text stays editable, and relies on PowerPoint breaking it in the same places; SVG and PDF draw the measured lines at explicit baselines. Agreement therefore rests entirely on the font pair being metric-identical.
  - **Explicit text-box physics.** PowerPoint's default insets are 0.1 in left and right and 0.05 in top and bottom; the painter must set them to 0 (the file shows `lIns="0"`). Line pitch is written as an exact value (`spcPts`, for example 21.6 pt for bullets) instead of a multiple, bullet indent as a hanging indent (`marL` 20 pt), and paragraph spacing as space before. The scene must also say where the first baseline sits; the prototype centres the font's ascent plus descent in the line pitch, and whether PowerPoint places it identically was not checked.
  - **Charts are data and drawing at once.** The native chart gets the data plus every decision layout made that PowerPoint lets us pin: axis maximum and step, label font and size, and which category labels to skip (`tickLblSkip`). The plot area inside the chart frame is still placed by PowerPoint, so SVG/PDF charts can only resemble the PowerPoint chart. pptxgenjs also writes Arial into the hidden data-label style even when Calibri is asked for; set the data-label font too.
  - **Tables behave the same way:** layout computes row heights from wrapped cells and passes them as `rowH`; PowerPoint may still grow a row if its wrap differs. Table cell margins in pptxgenjs 4.0.1 are in inches while text-box margins are in points.
  - **Document furniture:** a per-slide outline title, link targets on paragraphs, letter spacing for the eyebrow, and a kerning policy (below) all had to become scene properties.
- An existing defect surfaced on the way: the current SVG preview draws on a 1280 x 720 pixel view box but uses the point sizes as pixel sizes (realtime-modules `src/deck/renderSlideSvg.ts:248`, `:258`), so preview text is 75% of the size PowerPoint shows. The 0.52-per-character width guess (`renderSlideSvg.ts:65`) overestimates real widths by a median of 25% in Carlito and 16% in Liberation Sans (worst 46%).

### 2. PDF with pdfkit 0.21.0

- **Fonts embedded:** `pdffonts` lists `Carlito-Bold` and `Carlito-Regular` as CID TrueType, Identity-H, embedded, subset, with a Unicode map; each PDF has two `FontFile2` streams.
- **Text and reading order:** `pdftotext` (poppler 26.04) returns eyebrow, title, bullets in order, footer last, and the chart's axis values and labels as text. Two problems: letter-spaced text (the eyebrow) extracts as "F O U N D T E A M S", and on the overflowing long slide the bullet that runs into the footer gets interleaved with the footer text. Both are layout choices, not library limits: draw letter-spaced text without per-character spacing in the PDF, or accept it; and do not ship an overflowing slide.
- **Outline and links:** one `/Outlines` tree per file with a numbered entry per slide; each Sources table row carries a `/URI` link annotation (4 in the short deck, 5 in the long deck).
- **Vector chart:** bars, grid lines, polylines and markers are drawn as paths; nothing is rasterised.
- **Sizes and time:** 28.6 KB (short, 5 slides), 34.9 KB (long, 6), 30.7 KB (chart, 4). Painting takes 0.7 to 3.0 ms per slide after the first, and 9 to 17 ms for the first page of a deck (font registration); whole documents including font subsetting take 21 to 28 ms. Layout costs 4.6 to 14.3 ms per slide, most of it measuring candidate lines while wrapping; the long deck is the slow one and a word-width cache would cut it.
- **Not tried, so not claimed:** tagged PDF for accessibility, PDF/A, right-to-left or complex scripts. pdfkit documents the first two; they need their own check.

### 3. Font metrics and the pairs

- 50 strings from the test decks: titles in bold at 28 or 40 pt, bullets at 18 pt, chart labels at 11 pt, measured with fontkit shaping.
- **Liberation Sans 2.1.5 against the Arial in the macOS system fonts (version 5.01.2x), read in place:** largest difference 0%, median 0%, with or without kerning; zero of 95 printable ASCII characters differ in advance width, regular or bold. The pair is metric-compatible for Latin text.
- **Carlito against Calibri:** Calibri is not present in the system font folders or in an Office install on this Mac, so the comparison was not made. Verified instead: the Carlito widths themselves (in `out/metrics.json` of the prototype), and that the npm-shipped Carlito matches the TTF. The claim that Carlito matches Calibri rests on the font's own documentation until someone runs the same script on a machine with Office.
- **Kerning is a second, smaller risk.** Kerning changes Carlito line widths by a median of 0.45% and at most 1.4% (Liberation Sans: at most 0.37%). pptxgenjs writes no kerning attribute on text boxes, so PowerPoint probably does not kern them, while the measurement, resvg and pdfkit all kern. Re-wrapping every paragraph of the three decks without kerning changed no line breaks in 104 lines, so the risk is real but rare. Decide one policy and write it into the file (`kern` on each run) and into the measurement.
- Fonts were never copied: the script opens the system Arial files in place and writes only numbers.

### 4. Raster output with resvg

- 24 probe lines (Carlito at 10, 11, 18, 32 and 40 pt; Liberation Sans at 11, 28 and 40 pt) were each rendered alone at 1920 wide. The leftmost and rightmost inked pixel columns agree with the ink extent computed from the font's glyph boxes within a median of 0.57 px and at most 0.81 px, which is under half a point. Text renders in the bundled font, at the scene's positions.
- Rasterising costs 25 ms per slide for ordinary slides and 55 ms for the dense ones.
- What the runtime image needs: the font files on disk and passed to resvg by path (`fontFiles`), system fonts switched off (`loadSystemFonts: false`) so nothing else substitutes, and no fontconfig at all, because resvg brings its own font database. **The trap:** when an SVG names a family that was not passed in, resvg 2.6.2 did not fall back; the process was killed (exit 137) both with no fonts and with only the other family loaded. The same slide with the family renamed to a loaded font rendered at once. A product painter must check every family in the scene against the loaded set before rasterising, and should rasterise out of process.
- `sharp` was not tried; the plan names it (decision 4). sharp renders SVG through librsvg and fontconfig, so it needs fontconfig configured with the bundled fonts in the image; resvg avoids that.

### 5. Agreement between painters

- LibreOffice (`soffice`) is not installed and was not installed. **The PowerPoint file's rendering was not checked by any renderer.** What was checked about the file is its XML: every text run has an explicit size (`sz` 1000 to 4000), zero insets, exact line pitch, Calibri or Arial as the face, one native chart per chart slide, one native table, hyperlinks, and `normAutofit` (shrink) kept as the safety net.
- SVG-to-PNG (resvg) against PDF-to-PNG (pdftoppm at 144 dpi), both 1920 x 1080, per slide, share of pixels that differ:

| Deck | Counting antialiased pixels | Ignoring antialiasing |
| --- | --- | --- |
| short (5 slides) | 0.30% to 0.45% | 0.02% to 0.08% |
| long (6 slides) | 0.48% to 5.40% | 0.09% to 0.43% |
| chart (4 slides) | 0.37% to 1.08% | 0.00% to 0.08% |

- The difference images show outlines of glyphs only, consistent with the two rasterisers rounding fractional baselines differently; no text box, bar or line moved. The dense long-text slides score highest simply because they have the most glyph edges.

### 6. Text fitting

- Rule shipped in the prototype. Title: try 28, 26, 24 pt on one line (title layout: 40, 36, 32 pt); if none fits, wrap at the last step; more than two lines, or taller than the title region, is an error finding and the text is kept, not cut. Bullets: 18 pt, 1.2 line pitch, 10 pt between bullets, 20 pt hanging indent; wrapping past the body region is an error finding naming the first bullet that crosses. Chart labels: when the widest label does not fit its slot, show every nth label and report it, and pass the same skip to PowerPoint.
- Findings for the long-text deck, verbatim:
  - l1: title wrapped to 2 lines at 32pt
  - l2: title wrapped to 2 lines at 24pt
  - l2: bullets: 16 lines need 416pt of a 328pt region (88pt over); bullet 7 is the first to cross
  - l3: title wrapped to 2 lines at 24pt
  - l3: left column: 18 lines need 419pt of a 328pt region (91pt over); bullet 4 is the first to cross
  - l3: right column: 19 lines need 440pt of a 328pt region (113pt over); bullet 3 is the first to cross
  - l5: title wrapped to 2 lines at 24pt
  - l5: chart caption: 4 lines need 96pt of a 71pt region (25pt over); bullet 2 is the first to cross
- The chart deck reported one finding: the widest month label is 81 pt in a 69 pt slot, so every second label is shown. The short deck reported none.
- Consequence for the caps: 8 bullets of 200 characters cannot fit one slide at 18 pt in either font. With these metrics the full-width body region holds 6 two-line bullets (bullet 7 is the first to cross), while 5 bullets of 120 characters fit with room to spare. The validator's caps (`MAX_BULLETS_PER_SLIDE` 8, `MAX_BULLET_CHARS` 200) allow decks that will always overflow; layout findings will catch them, but the caps or the prompt should be tightened so drafts rarely trip them.

## What this changes in the plan

- **Decision 3, font pairs:** keep the pairs, but treat Calibri with Carlito as unproven until the metrics script runs on a machine with Office; Arial with Liberation Sans is proven. Add a kerning policy: write `kern` explicitly on every PowerPoint run and measure the same way.
- **Decision 3, the scene model:** add to the plan that a text element carries unbroken paragraphs and measured lines, explicit insets, exact line pitch, hanging indent and first-baseline rule; and that chart and table elements carry data plus pinned decisions (axis range, label skip, fonts, row heights) for PowerPoint and drawn parts for SVG/PDF. Say plainly that the PowerPoint chart's inner plot area is PowerPoint's, so the conformance check should compare charts loosely.
- **Decision 4, PDF:** pdfkit 0.21.0 is good enough; name it. Avoid per-character spacing in text that must extract cleanly.
- **Decision 4, PNG:** prefer `@resvg/resvg-js` over `sharp` for rasterising the preview: it needs no fontconfig and measured within a pixel. Whichever is used, validate every font family against the loaded set first and rasterise out of process, because a missing family kills the process.
- **Phase 1:** fix the preview's point-versus-pixel scale (text at 75%) as part of replacing it, since the new SVG painter uses points directly. Bundle the fonts as TTF files, not Fontsource WOFF2 subsets. Add a finding-driven check of the caps (8 x 200 characters always overflows). Budget: layout plus all three painters for a 6-slide dense deck is well under half a second, so a render time budget is easy to meet.
- **Risks:** "the engine package gets heavy" is confirmed at roughly 11 MB of libraries and 3 MB of fonts for two families; keep the subpath split.

## Not verified

- How PowerPoint, Keynote, Google Slides or LibreOffice render the generated `.pptx`: no renderer was available, so line breaks, first-baseline position, chart plot area and the effect of `normAutofit` in a real program are unchecked.
- That Carlito matches Calibri: Calibri is not on this machine.
- Whether PowerPoint kerns runs that carry no `kern` attribute; the prototype assumes it does not.
- Tagged PDF, PDF/A, and non-Latin or right-to-left text in any painter.
- resvg and pdfkit inside the Linux container image; everything ran on macOS with Node 25.
- `sharp` for rasterising, which the plan names; only resvg was tried.
