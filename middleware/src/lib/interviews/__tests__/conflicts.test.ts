// Double-booking (ledger row C-17): the overlap arithmetic and which rounds count.
import { seatConflicts, windowsOverlap } from '../conflicts.js';
import type { Interview } from '../types.js';

const T0 = Date.parse('2031-03-04T14:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const iv = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-this', applicationId: 'ap-1', roundId: 'r-1', type: 'technical', leadId: 'u-hugo', panelIds: ['u-wen'], scheduledAt: at(0), minutes: 60,
  state: 'accepted', questionIds: [], assignedBy: 'u-greta', assignedAt: at(-1000), callId: null, endedAt: null, acceptances: [], declines: [], revision: 1, ...over,
});
const names: Record<string, string> = { 'u-hugo': 'Hugo Marchetti', 'u-wen': 'Wen Zhao', 'u-ola': 'Ola Brandt' };
const nameOf = (id: string) => names[id] ?? id;

describe('windowsOverlap', () => {
  const w = (start: number, minutes: number) => ({ scheduledAt: at(start), minutes });
  it('touching windows do not conflict, either way round', () => {
    expect(windowsOverlap(w(0, 60), w(60, 60))).toBe(false);
    expect(windowsOverlap(w(60, 60), w(0, 60))).toBe(false);
  });
  it('identical, contained and partial windows do', () => {
    expect(windowsOverlap(w(0, 60), w(0, 60))).toBe(true);
    expect(windowsOverlap(w(0, 60), w(15, 15))).toBe(true);
    expect(windowsOverlap(w(15, 15), w(0, 60))).toBe(true);
    expect(windowsOverlap(w(0, 60), w(59, 60))).toBe(true);
    expect(windowsOverlap(w(30, 60), w(0, 31))).toBe(true);
  });
  it('a round without a time overlaps nothing', () => {
    expect(windowsOverlap({ scheduledAt: null, minutes: 60 }, w(0, 60))).toBe(false);
  });
});

describe('seatConflicts', () => {
  it('names each booked seat, lead and panel, with the other round\'s id, start and minutes and no candidate', () => {
    const other = iv({ id: 'iv-other', leadId: 'u-ola', panelIds: ['u-hugo'], scheduledAt: at(30), minutes: 45 });
    const third = iv({ id: 'iv-third', leadId: 'u-wen', panelIds: [], scheduledAt: at(-30), minutes: 31 });
    const out = seatConflicts(iv(), [iv(), other, third], nameOf);
    expect(out).toEqual([
      { person: { id: 'u-hugo', name: 'Hugo Marchetti' }, interviewId: 'iv-other', scheduledAt: at(30), minutes: 45 },
      { person: { id: 'u-wen', name: 'Wen Zhao' }, interviewId: 'iv-third', scheduledAt: at(-30), minutes: 31 },
    ]);
    expect(Object.keys(out[0]!).sort()).toEqual(['interviewId', 'minutes', 'person', 'scheduledAt']);
  });
  it('a round does not conflict with itself, nor with a touching round', () => {
    expect(seatConflicts(iv(), [iv(), iv({ id: 'iv-next', scheduledAt: at(60) })], nameOf)).toEqual([]);
  });
  it('cancelled, declined, ended, scored and reviewed rounds are ignored; assigned, accepted, ready and live count', () => {
    for (const state of ['cancelled', 'declined', 'ended', 'scored', 'reviewed'] as const) {
      expect(seatConflicts(iv(), [iv({ id: 'iv-other', state })], nameOf)).toEqual([]);
    }
    for (const state of ['assigned', 'accepted', 'ready', 'live'] as const) {
      expect(seatConflicts(iv(), [iv({ id: 'iv-other', state })], nameOf)).toHaveLength(2);
    }
  });
  it('a person not seated on the other round is not in conflict', () => {
    expect(seatConflicts(iv(), [iv({ id: 'iv-other', leadId: 'u-ola', panelIds: [] })], nameOf)).toEqual([]);
  });
  it('a round with no time, or one that no longer holds its time, has no conflicts', () => {
    const other = iv({ id: 'iv-other' });
    expect(seatConflicts(iv({ scheduledAt: null }), [other], nameOf)).toEqual([]);
    expect(seatConflicts(iv({ state: 'cancelled' }), [other], nameOf)).toEqual([]);
    expect(seatConflicts(iv({ state: 'ended' }), [other], nameOf)).toEqual([]);
  });
});
