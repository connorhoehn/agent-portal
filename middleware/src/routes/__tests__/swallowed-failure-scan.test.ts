// Swallowed failures — the check for the class, not the instance.
//
// THE SHAPE. A handler catches an outbound or database failure and answers
// `200` with an empty collection. It is defensible on its own terms — failing
// a whole page because one panel's upstream is down is a worse answer — but it
// destroys the difference between "there is nothing here" and "we could not
// look", and NOTHING we have can see it:
//
//   * the GET wire capture records status codes and shapes, and a swallowed
//     failure and an idle collection are both `200 {"xs":[]}`;
//   * the write-path reachability scan (mock/core/wire/mock-branches.ts) does
//     not look at GET routes at all, by construction;
//   * a unit test that mocks the provider never exercises the catch.
//
// It took a human read of one route to find `GET /api/environments/:id/runs`,
// where the swallowed thing was a `fetch` to api.github.com. This file is the
// mechanical version of that read, so the next one is found by a test run.
//
// THE RULE. A `catch` that responds with an empty collection must SAY the
// response is degraded. `routes/cost.ts` set the precedent and its tests pin
// it: a healthy empty window carries no marker, every failure carries
// `degraded: true` plus the first line of the error. A marker named `note`
// does not count — `note` is where an ordinary fact about the org goes ("no
// repository is linked to this initiative"), and mixing the two is precisely
// how a broken integration came to read as an idle repository.
//
// THE LIST. It is empty, and the mechanism that made it empty is the point.
// Twenty-three sites across ten routers — every observability read on
// calibration, drift, guardrail detail, invocation search, KB admin, memory,
// quality, score history, tool calls and traffic — swallowed a database
// failure into an unmarked empty collection. They were enumerated here WITH
// REASONS rather than exempted into silence, on the same contract as
// mock/core/wire/allow.ts: a `DEFECT:` entry is an unfixed bug on the record,
// not an accepted difference, and a stale entry — one naming a site that no
// longer swallows — FAILS, so the list could not outlive the problem. All
// twenty-three now answer through a `degraded()` wrapper. The number may go
// down. It must never go up.
//
// WHAT THIS CANNOT SEE. Say it out loud, as docs/mock-floor.md does for the
// judge, so nobody over-trusts it:
//
//   * It is lexical. Only a `res.json` INSIDE a catch block counts. A handler
//     that catches into a local, then answers after the try (routes/oncall.ts
//     builds one event feed across several separately-guarded reads) is
//     invisible here, and so is a swallow that happens a call deep — every
//     provider that returns `[]` on failure (providers/agentcore.ts's three
//     `listRuntimes`/`listCodeSessions`/`listBrowserSessions` catches,
//     providers/bots.ts's `safeExec`, lib/site-survey.ts's robots parse) hands
//     its route an empty array the route has no way to tell from a real one.
//   * It is a shape, not a semantics. A response marked `degraded` is accepted
//     without checking that the marker is ever TRUE, or that a healthy empty
//     answer omits it. That second half is a per-route test's job — see
//     environments-runs-degraded.test.ts and cost-routes.test.ts.
//   * It reads `src/routes/**` only, and only the top level of it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { middlewareRoot } from '../../mock/core/wire/paths.js';

// `paths.ts` walks up from the cwd rather than using `__dirname`/`import.meta`,
// because jest runs this file as CJS and `npx tsx` runs it as ESM and neither
// meta-property exists in both. Reused rather than re-derived.
const ROUTES_DIR = join(middlewareRoot(), 'src/routes');

/**
 * A property name that states the response is not a normal answer.
 *
 * `degraded` is the precedent (cost.ts). `problem` and `error` are the two
 * other spellings already in the tree for the same idea. `partial` is the
 * search contract's own spelling (providers/search.ts `SearchResponse.partial`:
 * the sources that could not be read, which also sets `totalIsLowerBound`);
 * GET /api/assessment/recordings/search answers a caught failure with
 * `{ records: [], partial: ['Recordings unavailable'] }`, which is marked.
 * `note` is NOT here:
 * it carries facts as often as failures, which is the ambiguity being removed.
 */
const MARKERS = new Set(['degraded', 'problem', 'error', 'partial']);

interface Swallow {
  /** `routes/<file>.ts:<line>` — the `res.json` inside the catch. */
  site: string;
}

/** `res.json(x)` / `res.status(n).json(x)` — the argument, or undefined. */
function responseArgument(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'json') return undefined;

  // The receiver is `res`, or `res.status(...)`.
  let receiver: ts.Node = callee.expression;
  if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
      && receiver.expression.name.text === 'status') {
    receiver = receiver.expression.expression;
  }
  if (!ts.isIdentifier(receiver) || !/^_?res$/.test(receiver.text)) return undefined;
  return node.arguments[0];
}

/**
 * Strip the wrappers that do not change the value: `satisfies T`, `as T`, and
 * parentheses. Half the observability routes write
 * `res.json({ points: [] } satisfies RpsResponse)`, and a scan that did not
 * unwrap would silently acquit every one of them — a check that reports a
 * clean tree because it cannot see is worse than no check.
 */
function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let cur = node;
  while (cur && (ts.isSatisfiesExpression(cur) || ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur))) {
    cur = cur.expression;
  }
  return cur;
}

/** An empty array literal, or an object literal with one as a property value. */
function isEmptyCollection(raw: ts.Expression | undefined): boolean {
  const arg = unwrap(raw);
  if (!arg) return false;
  if (ts.isArrayLiteralExpression(arg)) return arg.elements.length === 0;
  const obj = ts.isCallExpression(arg) ? unwrap(arg.arguments[0]) : arg;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return false;
  return obj.properties.some((p) =>
    ts.isPropertyAssignment(p)
    && ts.isArrayLiteralExpression(p.initializer)
    && p.initializer.elements.length === 0);
}

/** Does the response say it is degraded — by a marker property, or by being
 *  wrapped in a helper named for one (cost.ts's `degraded(body, err)`)? */
function isMarked(raw: ts.Expression | undefined): boolean {
  const arg = unwrap(raw);
  if (!arg) return false;
  if (ts.isCallExpression(arg)) {
    const callee = arg.expression;
    if (ts.isIdentifier(callee) && MARKERS.has(callee.text)) return true;
    return isMarked(arg.arguments[0]);
  }
  if (!ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((p) => {
    const name = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
      ? p.name && ts.isIdentifier(p.name) ? p.name.text : ''
      : '';
    return MARKERS.has(name);
  });
}

function scanFile(file: string): Swallow[] {
  const abs = join(ROUTES_DIR, file);
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2022, true);
  const found: Swallow[] = [];

  const walk = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      // Only responses lexically inside the catch. A response AFTER the
      // try/catch (oncall.ts's event feed builds a list across several
      // guarded reads and answers once) is a different, harder shape and is
      // a stated blind spot rather than a silent one.
      const inCatch = (n: ts.Node): void => {
        const arg = responseArgument(n);
        if (arg && isEmptyCollection(arg) && !isMarked(arg)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          found.push({ site: `routes/${file}:${line}` });
        }
        ts.forEachChild(n, inCatch);
      };
      ts.forEachChild(node.block, inCatch);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sf, walk);
  return found;
}

function scanRoutes(): Swallow[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .flatMap(scanFile);
}

/**
 * Every site that still answers a caught failure with an unmarked empty
 * collection, and why it is not fixed.
 *
 * Empty, as of the slice that converted the last of them. Each was an
 * Aurora- or Bedrock-backed read that `console.warn`ed server-side and handed
 * the page an empty array, so a torn-down cluster and a quiet fortnight
 * rendered identically; each now answers through the same `degraded()` wrapper
 * routes/cost.ts introduced.
 *
 * A new entry here is admissible, but only with a reason that says what makes
 * the site different — not "not fixed yet". The two shapes that would earn one:
 * a response whose healthy form is a bare top-level array with no room for a
 * marker (drift's /summary was that, and answers the object form on failure
 * only, because every consumer already guards with `Array.isArray`), and a
 * response whose consumer cannot be changed in the same slice.
 */
const UNFIXED: Record<string, string> = {};

describe('a caught failure never answers as an ordinary empty collection', () => {
  const found = scanRoutes();
  const sites = found.map((f) => f.site);

  it('reports no site that is not on the written list', () => {
    const surprises = sites.filter((s) => !(s in UNFIXED));
    expect({ unlisted: surprises }).toEqual({ unlisted: [] });
  });

  it('has no stale entries — a listed site that no longer swallows must be deleted', () => {
    const gone = Object.keys(UNFIXED).filter((s) => !sites.includes(s));
    expect({ stale: gone }).toEqual({ stale: [] });
  });

  it('makes every listed site say why, so nothing is exempted in silence', () => {
    for (const [site, reason] of Object.entries(UNFIXED)) {
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(site).toMatch(/^routes\/[\w.-]+\.ts:\d+$/);
    }
  });

  it('does not list the environments run report — this slice fixed it', () => {
    expect(sites.filter((s) => s.startsWith('routes/environments.ts'))).toEqual([]);
  });

  it('does not list cost.ts, which set the precedent', () => {
    expect(sites.filter((s) => s.startsWith('routes/cost.ts'))).toEqual([]);
  });

  // Named individually rather than left to the empty-list assertion above,
  // so a reintroduced swallow in one of these files fails with the file's
  // name in the message instead of a bare unlisted-site diff.
  const CONVERTED = [
    'calibration', 'drift', 'guardrails-detail', 'invocations', 'kb-admin',
    'memory', 'quality', 'scores', 'tool-calls', 'traffic',
  ];

  it.each(CONVERTED)('routes/%s.ts states its degraded reads', (name) => {
    expect(sites.filter((s) => s.startsWith(`routes/${name}.ts`))).toEqual([]);
  });

  it('the written list is empty — every known swallow is converted', () => {
    expect(UNFIXED).toEqual({});
  });
});

describe('the scanner itself', () => {
  // A scan is only evidence if it can be shown to detect and to acquit. These
  // exercise the four decisions it makes, so a refactor that quietly turns it
  // into a no-op fails here rather than reporting a clean tree forever.
  const parse = (src: string): boolean => {
    const sf = ts.createSourceFile('t.ts', src, ts.ScriptTarget.ES2022, true);
    let hit = false;
    const walk = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        const inCatch = (n: ts.Node): void => {
          const arg = responseArgument(n);
          if (arg && isEmptyCollection(arg) && !isMarked(arg)) hit = true;
          ts.forEachChild(n, inCatch);
        };
        ts.forEachChild(node.block, inCatch);
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(sf, walk);
    return hit;
  };

  it('flags an unmarked empty collection in a catch', () => {
    expect(parse('try { f(); } catch (e) { res.json({ runs: [] }); }')).toBe(true);
  });

  it('flags a bare empty array too', () => {
    expect(parse('try { f(); } catch (e) { res.json([]); }')).toBe(true);
  });

  it('acquits a marked one', () => {
    expect(parse('try { f(); } catch (e) { res.json({ runs: [], degraded: true, error: m }); }')).toBe(false);
  });

  it('acquits cost.ts’s wrapper form', () => {
    expect(parse('try { f(); } catch (e) { res.json(degraded({ points: [] }, e)); }')).toBe(false);
  });

  it('does not accept `note` as a marker — that is the ambiguity being removed', () => {
    expect(parse('try { f(); } catch (e) { res.json({ runs: [], note: e.message }); }')).toBe(true);
  });

  it('leaves a NON-empty response in a catch alone', () => {
    expect(parse('try { f(); } catch (e) { res.status(502).json({ error: e.message }); }')).toBe(false);
  });

  it('leaves an empty collection OUTSIDE a catch alone — that is a real empty', () => {
    expect(parse('if (!repo) { res.json({ runs: [] }); }')).toBe(false);
  });
});
