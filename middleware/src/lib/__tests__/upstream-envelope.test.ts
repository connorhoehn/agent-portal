// The envelope itself — lib/upstream.ts.
//
// Small enough to read, load-bearing enough to pin: every provider in this
// slice reports failure through these four functions, and the property that
// makes the whole thing safe to adopt one caller at a time is that a HEALTHY
// answer is indistinguishable from the plain value it replaced. If
// `degradedFields` ever started emitting a key on a healthy read, every route
// that spreads it would change shape and several route tests assert exact key
// sets — so that is asserted here, at the source, rather than N times over.

import {
  attempt, degradedFields, firstLine, problemFrom, reached, reasonLine, unreachable,
} from '../upstream.js';

describe('the healthy answer is the plain answer', () => {
  it('carries the value and no marker', () => {
    expect(reached([1, 2])).toEqual({ items: [1, 2] });
  });

  it('spreads nothing into a response', () => {
    // The property the whole design rests on: `{ xs: r.items,
    // ...degradedFields(r) }` on a healthy read is byte-identical to `{ xs }`.
    expect(degradedFields(reached([]))).toEqual({});
    expect(Object.keys({ sessions: [], ...degradedFields(reached([])) })).toEqual(['sessions']);
  });

  it('does not confuse an empty collection with a failure', () => {
    expect(reached([]).degraded).toBeUndefined();
  });
});

describe('the degraded answer still carries a renderable value', () => {
  it('keeps the fallback so a caller never has to handle a missing value too', () => {
    const r = unreachable([] as string[], new Error('boom'));
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
  });

  it('keeps a PARTIAL result rather than discarding it', () => {
    // A paged listing that fails on page three should report the two pages it
    // did read, marked — throwing them away buys nothing and loses evidence.
    const r = unreachable(['page-1', 'page-2'], new Error('throttled'));
    expect(r.items).toEqual(['page-1', 'page-2']);
    expect(r.degraded).toBe(true);
  });

  it('spreads the wire marker routes/cost.ts established', () => {
    expect(degradedFields(unreachable([], new Error('nope')))).toEqual({
      degraded: true, error: 'nope',
    });
  });
});

describe('firstLine — the label, not the stack trace', () => {
  it('takes only the first line', () => {
    expect(firstLine(new Error('HTTP 503\n  at foo\n  at bar'))).toBe('HTTP 503');
  });

  it('caps the length, because this is rendered on a page', () => {
    expect(firstLine(new Error('x'.repeat(500))).length).toBe(160);
  });

  it('has a stated fallback rather than an empty label', () => {
    // A thrown non-Error (a rejected string, an undefined) must not produce a
    // blank `error: ""`, which reads as a degradation with no reason at all.
    expect(firstLine(undefined)).toBe('upstream unavailable');
    expect(firstLine(new Error(''), 'lost the plot')).toBe('lost the plot');
    expect(firstLine('   \n')).toBe('upstream unavailable');
  });

  it('reads a thrown string', () => {
    expect(firstLine('token expired')).toBe('token expired');
  });
});

describe('attempt', () => {
  it('passes a successful read straight through', async () => {
    await expect(attempt(async () => [7], [] as number[])).resolves.toEqual({ items: [7] });
  });

  it('turns a throw into the degraded answer, with the note in front', async () => {
    const r = await attempt(async () => { throw new Error('timed out'); }, [] as number[], 'ListThings failed');
    expect(r).toEqual({ items: [], degraded: true, error: 'ListThings failed: timed out' });
  });

  it('does not swallow — the reason survives', async () => {
    // The entire point. A `catch { return []; }` and this differ only in that
    // one of them can still answer "why".
    const r = await attempt(async () => { throw new Error('AccessDenied'); }, [] as string[]);
    expect(r.items).toEqual([]);
    expect(r.error).toContain('AccessDenied');
  });
});

describe('problemFrom', () => {
  it('is undefined when nothing degraded, so it can be spread conditionally', () => {
    expect(problemFrom(undefined, undefined)).toBeUndefined();
  });

  it('joins what did degrade', () => {
    expect(problemFrom(undefined, 'a failed', undefined, 'b failed')).toBe('a failed; b failed');
  });
});


// `reasonLine` — the banner text every degraded route now shares.
//
// It replaced ten verbatim copies of `message.split('\n')[0]?.slice(0, 160)`.
// The hard slice cut mid-word, so /admin/observability/oncall rendered
// "alarms: could not evaluat." — which a reader takes for a typo in the
// product rather than a truncated database error. These pin the two things
// that made it worth consolidating: WHERE it cuts, and that it says it cut.
describe('reasonLine', () => {
  it('keeps a short message verbatim, so existing banners do not change', () => {
    expect(reasonLine(new Error('relation does not exist'))).toBe('relation does not exist');
  });

  it('takes only the first line', () => {
    expect(reasonLine(new Error('first line\n  at stack (file.ts:1)'))).toBe('first line');
  });

  it('falls back when there is no message at all', () => {
    expect(reasonLine(undefined)).toBe('query failed');
    expect(reasonLine(new Error(''))).toBe('query failed');
    expect(reasonLine({}, 'nothing to say')).toBe('nothing to say');
  });

  it('cuts a long message at a word boundary and marks the cut', () => {
    const out = reasonLine(new Error(`${'word '.repeat(60)}end`));
    expect(out.endsWith('…')).toBe(true);
    // The whole point: no half-word before the ellipsis.
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
    expect(out).not.toMatch(/wor…$/);
    expect(out.length).toBeLessThanOrEqual(161);
  });

  it('does not strand most of the width on a long unbroken token', () => {
    // An ARN or URL has no space to cut at; a word-boundary rule would throw
    // away everything after the last early space, which is worse than a hard
    // cut. Such a value keeps the full 160.
    const out = reasonLine(new Error('x'.repeat(400)));
    expect(out).toBe(`${'x'.repeat(160)}…`);
  });

  it('does not leave a dangling separator before the ellipsis', () => {
    const out = reasonLine(new Error(`${'alpha beta, '.repeat(20)}tail`));
    expect(out).not.toMatch(/[.,;:]…$/);
  });
});
