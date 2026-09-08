// Rule 4's write scan, widened to see outbound `fetch`.
//
// Until 2026-09 the scan counted `.send(...)` (AWS SDK) and `exec(...)` (RDS
// Data API) and nothing else, so "reaches a backend dev:mock cannot answer"
// really meant "reaches AWS". Anything spoken over plain HTTP was structurally
// invisible — `lib/github-connector.ts` talks to api.github.com and no check in
// the repo could name it, which `docs/mock-floor.md § What the judge cannot
// see` said out loud. These tests pin the widening in both directions: what it
// must now find, and what it must still refuse to call a finding.

import ts from 'typescript';
import {
  isSameOriginFetch,
  hasOutboundFetch,
  scanWriteRoutesWithoutMockBranch,
} from '../../mock/core/wire/mock-branches.js';

function fnNode(src: string): { node: ts.Node; sf: ts.SourceFile } {
  const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.ES2022, true);
  const node = sf.statements[0];
  if (!node) throw new Error('probe source declared nothing');
  return { node, sf };
}

const outbound = (src: string): boolean => {
  const { node, sf } = fnNode(src);
  return hasOutboundFetch(node, sf);
};

describe('what counts as an outbound fetch', () => {
  it('finds a fetch at a literal external URL', () => {
    expect(outbound("async function f() { await fetch('https://api.github.com/user'); }")).toBe(true);
  });

  it('finds a fetch whose URL is a variable — a name-resolving scan cannot see where it points', () => {
    expect(outbound('async function f() { const u = build(); await fetch(u, { method: "POST" }); }')).toBe(true);
  });

  it('finds a template whose FIRST element is an interpolation', () => {
    // `${origin}/robots.txt` in lib/site-survey.ts: that origin is the site
    // being surveyed, not ours. Treating a leading `${` as self-origin would
    // have silently exempted the one finding this widening actually adds.
    expect(outbound('async function f() { await fetch(`${origin}/robots.txt`); }')).toBe(true);
  });

  it('finds a fetch nested inside a callback or a try block', () => {
    expect(outbound('async function f() { try { await fetch("https://x.test/y"); } catch {} }')).toBe(true);
    expect(outbound('async function f() { items.map(async (i) => fetch(`https://x.test/${i}`)); }')).toBe(true);
  });

  it('does NOT count a fetch at our own origin', () => {
    // A call answered by the same mock middleware the caller is running inside
    // is not a backend dev:mock has to stand in for.
    expect(outbound("async function f() { await fetch('/api/session/me'); }")).toBe(false);
    expect(outbound('async function f() { await fetch(`/api/runs/${id}/stop`, { method: "POST" }); }')).toBe(false);
    expect(outbound("async function f() { await fetch('http://localhost:3001/api/health'); }")).toBe(false);
    expect(outbound("async function f() { await fetch(`http://127.0.0.1:${port}/api/health`); }")).toBe(false);
  });

  it('does NOT count a function with no fetch at all', () => {
    expect(outbound('async function f() { return exec("SELECT 1"); }')).toBe(false);
  });

  it('classifies the URL argument, not the method or the options', () => {
    expect(isSameOriginFetch("'/api/x'")).toBe(true);
    expect(isSameOriginFetch('`/api/${id}`')).toBe(true);
    expect(isSameOriginFetch("'https://api.github.com/x'")).toBe(false);
    expect(isSameOriginFetch('`${API}/repos`')).toBe(false);
    expect(isSameOriginFetch('url')).toBe(false);
  });
});

describe('the scan over this repo', () => {
  // One full scan; it parses every file under src/{routes,lib,providers}.
  const findings = scanWriteRoutesWithoutMockBranch();
  const providers = new Set(findings.map((f) => f.provider));
  const has = (needle: string): boolean => [...providers].some((p) => p.includes(needle));

  it('MUST find a leaf whose only outbound call is a fetch', () => {
    // lib/site-survey.ts `disallowedPrefixes` GETs the surveyed origin's
    // robots.txt and does nothing else. Before the widening it was reachable
    // from POST /api/ingest/survey and reported by nothing.
    expect(has('site-survey.ts')).toBe(true);
    expect(has('disallowedPrefixes()')).toBe(true);
    expect(findings.some((f) => f.route === 'POST /api/ingest/survey'
      && f.provider.includes('disallowedPrefixes()'))).toBe(true);
  });

  it('MUST NOT name the HTTP transport wrapper itself', () => {
    // Same argument that excludes `exec`: `gh()` IS the GitHub wire, so
    // reporting it prints "the wire is the wire" once per caller and buries
    // the function above it that decides whether an offline path exists.
    expect(has('github-connector.ts:60 gh()')).toBe(false);
    expect([...providers].filter((p) => / gh\(\)$/.test(p))).toEqual([]);
  });

  it('MUST NOT report a fetch that sits under a config.mock branch', () => {
    // `openPullRequest` is a real, unguarded outbound fetch — but the only
    // write path to it is lib/change-delivery.ts, which branches on
    // `config.mock.agentcore` above the call and hands back a fixture PR. The
    // search stops at the guard, so this is a proven negative rather than the
    // blindness it was before `fetch` was counted at all.
    expect(has('openPullRequest()')).toBe(false);
    // Nothing in github-connector.ts is reachable-and-unguarded from a write
    // route today. If that changes, this test is the thing that should fail.
    expect(has('github-connector.ts')).toBe(false);
  });

  it('reports each route -> leaf pair once, sorted, with the route and leaf both named', () => {
    const keys = findings.map((f) => `${f.route} -> ${f.provider}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of findings) {
      expect(f.route).toMatch(/^(POST|PUT|PATCH|DELETE) \//);
      expect(f.provider).toMatch(/^src\/(lib|providers)\/.+:\d+ \w+\(\)$/);
    }
  });
});
