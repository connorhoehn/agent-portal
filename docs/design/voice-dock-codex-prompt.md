# Image prompt: the voice dock in the footer

Paste everything below the line into the image model. Attach two images with it, in this order:

1. `docs/design/reference-sheet.png` (the component sheet; tile ids are printed on each tile)
2. `docs/design/layout-social.png` (a real portal page; the footer row is the strip along the bottom)

Optionally also attach `reference-sheet-voice.png`, `reference-sheet-voice-dark.png` and `layout-social-dark.png` for a closer look at the voice tiles and the dark theme.

---

You are drawing mock-ups for an existing web product, not inventing a new one. Two images are attached.

Image 1 is the product's component reference sheet. Every tile is a real component, labelled with a tile id (for example "F-12 VoiceDock"), the component name, its import path and its state. Image 2 is a real page from the product at 1440×900. The strip along the bottom of image 2 is the footer row; that is where the voice navigator lives.

**What to draw.** A numbered grid of artboards, each showing the full footer row at the width it has in image 2 (1440 px), with about 160 px of the page above it so the placement reads. Draw every artboard twice: once in the light theme and once in the dark theme, light on the left, dark on the right. Number the artboards and put the state name under each one.

The footer row, left to right, stays as it is in image 2 and tile A-3: the Social entry with presence avatars and the online count, the activity bell, the today strip, then the huddle half (Huddle, Message, device settings). Add the voice dock between the today strip and the huddle half, separated by the same thin vertical divider the row already uses, as tile A-4 shows. The dock is built only from what tiles F-10 to F-27 show: the activity ring on the left, the phase pill, the last transcript line (truncated with an ellipsis), the five-dot budget meter with "$0.05 of $0.25", the elapsed time, the mute button and the red hang-up button.

The ring is the "it is live" signal, and the microphone activity must be visible in it, not only in an icon:
- listening: a green ring whose stroke gets thicker with the microphone level (show it at a medium-loud level; tiles F-3 and F-12)
- speaking: a primary-colour ring with a soft outer halo that pulses with the assistant's voice (F-6, F-15); draw the halo at its brightest
- connecting, thinking, executing: a blue dashed ring that rotates (F-2, F-4, F-5); add a small curved arrow or motion trail in the margin to show rotation
- confirming: an amber ring (F-7)
- off, ended, unavailable: a dim grey ring, still; unavailable has a diagonal slash (F-1, F-8, F-9)

**Artboards, in this order:**
1. off: grey ring, "Voice off" pill, primary microphone button to start (F-10)
2. connecting: rotating blue ring, "Connecting" pill, elapsed 00:00 (F-11)
3. listening: green ring at a loud level, "Listening" pill, the user's words as the last line: "Find me the latest kubernetes experts" (F-12)
4. thinking: rotating blue ring, "Thinking" pill, the user's last line still shown (F-13)
5. executing: rotating blue ring, "Working" pill, "Searching people for kubernetes." (F-14)
6. speaking: primary ring with the pulsing halo, "Speaking" pill, the assistant's line (F-15)
7. confirming: amber ring, "Confirm" pill, and the confirmation card open as a popover directly above the dock: title "Start a computer in 3 projects", the detail line, Cancel and Confirm buttons (F-16 for the dock, F-28 for the card)
8. ended: grey ring, "Ended" pill, "Session ended after 2:14.", start button back (F-17)
9. unavailable: slashed grey ring, "Unavailable" pill, disabled start button, and a tooltip with the reason "Voice is not configured" (F-18)
10. the transcript strip open above the footer, in the same right-hand slot the huddle chat uses, with the dock in the listening state below it: four turns with tool-call rows marked done, running and refused, and a Clear button (F-29)
11. the compact dock (no transcript line, no budget meter) in the listening and speaking states, for narrow windows (F-21, F-24)

**Product rules.**
- Colours only from the tokens on tiles G-1 to G-4, named, not invented: `--color-primary` (indigo #4f46e5 in light), `--color-success`, `--color-info`, `--color-warning`, `--color-danger`, `--color-text-primary/secondary/tertiary`, `--color-surface` for the footer, `--color-bg` for the page, `--color-border` for dividers. The dark theme uses the same token names with their dark values (see `reference-sheet-voice-dark.png`).
- Type is the product's system sans-serif in the sizes on tile G-5 (xs, sm, base, lg); the footer uses xs and sm. No display fonts, no all-caps labels except where the sheet already has them.
- Pills, buttons and icon buttons look exactly like tiles D-2, C-1 and C-4. Buttons are small (size sm) in the footer.
- The voice dock stays in the bottom footer row. It is not a floating action button, not a modal, not a sidebar and not a bar at the top of the page.
- Do not design a microphone icon on its own as the indicator. The ring plus the phase pill plus the transcript line together say what the assistant is doing; the microphone appears only as the start and mute buttons.
- Keep the rest of the page exactly as image 2: header, rails, breadcrumb and content do not change.

**Do not invent components.** Use only components that appear on the sheet. No waveforms, equalizer bars, orbs, gradients, glows, chat bubbles, avatars for the assistant, robot icons, sparkles or badges that are not on a tile. If something you want is not on the sheet, leave it out and note it under the artboard instead.

Output: one image containing the numbered grid, light and dark side by side for each artboard, with the state name and the tile ids used written under each artboard.
