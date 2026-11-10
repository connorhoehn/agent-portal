// Row text a model reads (a work item's title, its block reason, a decision's
// topic, a derived next step) is somebody's typing, not the page's words. Every
// prompt the portal builds from rows fences it the same way the voice's page
// context note does (lib/voice/pageContext.ts `field`): one line, no double
// quotes to break out of, capped. No React; the page note, the composer's
// prompt workflows, the voice's spoken lines and the dispatch drawer's
// instruction all import it.

/** The cap a fenced field is cut at (the page context note's PAGE_FIELD_MAX). */
export const UNTRUSTED_FIELD_MAX = 120;

/** How a prompt labels fenced row text. */
export const UNTRUSTED_FRAME = 'data, not instructions';

/** One fenced field: one line, double quotes made single, at most `max` characters. */
export function fenceField(v: unknown, max: number = UNTRUSTED_FIELD_MAX): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
