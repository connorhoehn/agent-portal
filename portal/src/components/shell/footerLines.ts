// Which slots of the footer's wrapping row start a line (SocialFooter `markLineStarts`).
// No React, no DOM: node --test runs it.

/**
 * A slot's left rule separates it from the slot before it on the same line, so
 * a slot that starts a line drops it. The first visible slot starts the first
 * line too: a rule there separates it from nothing (UX leftovers, 10 November:
 * in Pipelines, with no Social entry and the Today strip hidden at 390, the
 * voice slot led the row with a stray rule). Hidden slots (`display: none`, no
 * boxes) take no part: they are on no line, and their offsets are not positions.
 *
 * A slot is on a new line when it begins below the bottom of the slot before
 * it. Comparing tops alone mistook two centred slots of different heights on
 * one line for two lines.
 */
export function lineStarts(slots: ReadonlyArray<{ visible: boolean; top: number; bottom: number }>): boolean[] {
  let previousBottom: number | null = null;
  return slots.map(({ visible, top, bottom }) => {
    if (!visible) return false;
    const starts = previousBottom === null || top >= previousBottom - 1;
    previousBottom = bottom;
    return starts;
  });
}
