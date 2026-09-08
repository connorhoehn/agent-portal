// The route ↔ test parity check, proven two ways:
//
//   1. `computeCoverage` against synthetic routes/calls — the segment-matching
//      rules (wildcard vs literal, length, method) with no filesystem in the
//      way.
//   2. `collectTestCalls` against a throwaway test file on disk, one per
//      argument shape `testCalls.ts` claims to resolve (string literal,
//      template literal, named const, unresolved-identifier fallback) plus
//      the one shape it deliberately leaves unresolved.
//
// This does NOT re-run `scripts/validate-route-coverage.sh`'s ratchet against
// the live repo — that comparison (today's count vs. the budget file) lives
// in the shell script on purpose, so bumping the budget never requires a
// matching source edit here. This suite only proves the matcher itself is
// correct; `docs/route-test-coverage.md` states what it still cannot see.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeCoverage, routerOf, rankedRouters, type CoverageReport } from '../scan.js';
import { collectTestCalls, findTestFiles } from '../testCalls.js';
import type { RouteRecord } from '../../wire/routes.js';

function route(method: RouteRecord['method'], path: string, source = 'src/routes/x.ts:1'): RouteRecord {
  return { method, path, source };
}

describe('computeCoverage — segment matching', () => {
  it('matches an exact literal path and method', () => {
    const routes = [route('GET', '/api/bots')];
    const calls = collectTestCallsFrom([{ method: 'GET', segments: lit('/api/bots') }]);
    expect(computeCoverage(routes, calls)[0]!.tested).toBe(true);
  });

  it('treats a route :param as matching any concrete segment', () => {
    const routes = [route('GET', '/api/bots/:id')];
    const calls = collectTestCallsFrom([{ method: 'GET', segments: lit('/api/bots/b-1') }]);
    expect(computeCoverage(routes, calls)[0]!.tested).toBe(true);
  });

  it('treats a templated call segment as matching any route segment', () => {
    const routes = [route('GET', '/api/bots/nightly')]; // a literal, non-param segment
    const calls = collectTestCallsFrom([{ method: 'GET', segments: [{ kind: 'literal', value: 'api' }, { kind: 'literal', value: 'bots' }, { kind: 'wildcard' }] }]);
    expect(computeCoverage(routes, calls)[0]!.tested).toBe(true);
  });

  it('does not match a different method against the same path', () => {
    const routes = [route('POST', '/api/bots')];
    const calls = collectTestCallsFrom([{ method: 'GET', segments: lit('/api/bots') }]);
    expect(computeCoverage(routes, calls)[0]!.tested).toBe(false);
  });

  it('does not match when segment counts differ', () => {
    const routes = [route('GET', '/api/bots/:id/runs')];
    const calls = collectTestCallsFrom([{ method: 'GET', segments: lit('/api/bots/b-1') }]);
    expect(computeCoverage(routes, calls)[0]!.tested).toBe(false);
  });

  it('does not match a literal route segment against a different literal call segment', () => {
    const routes = [route('GET', '/api/bots/nightly')];
    const calls = collectTestCallsFrom([{ method: 'GET', segments: lit('/api/bots/other') }]);
    expect(computeCoverage(routes, calls)[0]!.tested).toBe(false);
  });

  it('groups untested routes by their source file, worst router first', () => {
    const routes = [
      route('GET', '/api/a', 'src/routes/a.ts:1'),
      route('GET', '/api/a2', 'src/routes/a.ts:2'),
      route('GET', '/api/b', 'src/routes/b.ts:1'),
    ];
    const rows = computeCoverage(routes, []);
    expect(rows.map((r) => routerOf(r.route))).toEqual(['src/routes/a.ts', 'src/routes/a.ts', 'src/routes/b.ts']);
    const report: CoverageReport = {
      rows,
      untested: rows,
      byRouter: new Map([
        ['src/routes/a.ts', rows.slice(0, 2)],
        ['src/routes/b.ts', rows.slice(2)],
      ]),
    };
    expect(rankedRouters(report).map((r) => r.router)).toEqual(['src/routes/a.ts', 'src/routes/b.ts']);
  });
});

function lit(path: string) {
  return path
    .split('/')
    .filter(Boolean)
    .map((value) => ({ kind: 'literal' as const, value }));
}

function collectTestCallsFrom(
  entries: Array<{ method: RouteRecord['method']; segments: ReturnType<typeof lit> | Array<{ kind: 'literal'; value: string } | { kind: 'wildcard' }> }>,
) {
  return entries.map((e) => ({ ...e, display: '', source: 'x:1', resolvedVia: 'literal' as const }));
}

describe('collectTestCalls — argument resolution, on a throwaway fixture file', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'route-coverage-'));
    mkdirSync(join(root, 'src/routes/__tests__'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(contents: string) {
    writeFileSync(join(root, 'src/routes/__tests__/fixture.test.ts'), contents);
  }

  it('finds the file via the same walk the report uses', () => {
    write(`request(app).get('/api/x');`);
    expect(findTestFiles(root)).toEqual(['src/routes/__tests__/fixture.test.ts'].map((p) => join(root, p)));
  });

  it('resolves a plain string literal', () => {
    write(`it('t', async () => { const res = await request(app).get('/api/x'); });`);
    const calls = collectTestCalls(root);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', resolvedVia: 'literal' });
    expect(calls[0]!.segments).toEqual([{ kind: 'literal', value: 'api' }, { kind: 'literal', value: 'x' }]);
  });

  it('turns a templated segment into a wildcard, keeping the literal segments around it', () => {
    write('it(\'t\', async () => { const id = "b-1"; await request(app).get(`/api/bots/${id}/runs`); });');
    const calls = collectTestCalls(root);
    expect(calls[0]!.segments).toEqual([
      { kind: 'literal', value: 'api' },
      { kind: 'literal', value: 'bots' },
      { kind: 'wildcard' },
      { kind: 'literal', value: 'runs' },
    ]);
  });

  it('resolves a bare identifier bound by a same-file const', () => {
    write(`const path = '/api/y'; it('t', async () => { await request(app).post(path); });`);
    const calls = collectTestCalls(root);
    expect(calls[0]).toMatchObject({ method: 'POST', resolvedVia: 'named-const' });
    expect(calls[0]!.segments).toEqual([{ kind: 'literal', value: 'api' }, { kind: 'literal', value: 'y' }]);
  });

  it('falls back to every path-shaped literal in the file for an unresolved identifier — documented over-approximation', () => {
    write(
      `for (const p of ['/api/one', '/api/two']) { it('t', async () => { await request(app).get(p); }); }`,
    );
    const calls = collectTestCalls(root);
    expect(calls.every((c) => c.resolvedVia === 'file-wide-fallback')).toBe(true);
    expect(calls.map((c) => c.display).sort()).toEqual([
      '/api/one (unresolved var `p`, file-wide fallback)',
      '/api/two (unresolved var `p`, file-wide fallback)',
    ]);
  });

  it('does not credit a property-access argument — documented false negative', () => {
    write(`it('t', async () => { const bot = { id: 'b-1' }; await request(app).get(bot.id); });`);
    expect(collectTestCalls(root)).toEqual([]);
  });

  it('ignores a .get() call whose receiver is not request(...) — e.g. Map#get', () => {
    write(`it('t', () => { const m = new Map(); m.get('/api/not-a-route'); });`);
    expect(collectTestCalls(root)).toEqual([]);
  });
});
