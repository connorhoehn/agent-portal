// Day membership for work-graph rows. The library's `intervalOverlapsWorkDay`
// is half-open on both ends and so rejects a zero-length interval (a point
// event) stamped at exactly the window's first instant: `end > start` is false
// when end === start === window.start. A point at 00:00:00.000 belongs to the
// day it opens, so that one case is answered here; every other case is the
// library's own rule.

import { intervalOverlapsWorkDay as libraryOverlap, type WorkDayWindow } from '@connorhoehn/realtime-modules/work-graph';

export function intervalOverlapsWorkDay(startedAt: string, endedAt: string | undefined, window: Pick<WorkDayWindow, 'start' | 'end'>): boolean {
  if (endedAt !== undefined && Date.parse(startedAt) === Date.parse(window.start) && Date.parse(endedAt) === Date.parse(startedAt)) return true;
  return libraryOverlap(startedAt, endedAt, window as WorkDayWindow);
}
