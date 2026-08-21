// PR-watch poller — the pure halves, pinned.
//
// The poller's judgment lives in three small functions: which PRs a tick
// dispatches and where the watermark lands (nextDispatchSet), how a stored
// TEXT watermark reads (parseWatermark), and what counts as a GitHub PR url
// (parsePrUrl). Everything else is plumbing over exec() and the connector.

// The functions under test are pure; the mocks only keep the module loadable —
// config.ts uses import.meta, which the CJS test transform cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../../providers/connected-sources.js', () => ({ borrowApiKey: jest.fn() }));

import {
  nextDispatchSet,
  parseWatermark,
  parsePrUrl,
  renderPrReviewPrompt,
} from '../pr-watch-poller.js';
import type { PullSummary } from '../github-connector.js';

const pr = (number: number): { number: number } => ({ number });

describe('nextDispatchSet', () => {
  it('baselines a never-polled bot at the current max without dispatching history', () => {
    const r = nextDispatchSet([pr(7), pr(12), pr(3)], null);
    expect(r.toDispatch).toEqual([]);
    expect(r.newWatermark).toBe(12);
  });

  it('stays unpolled when there are no PRs yet', () => {
    const r = nextDispatchSet([], null);
    expect(r.toDispatch).toEqual([]);
    expect(r.newWatermark).toBeNull();
  });

  it('dispatches everything above the watermark, oldest first', () => {
    const r = nextDispatchSet([pr(15), pr(11), pr(13)], 11);
    expect(r.toDispatch.map((p) => p.number)).toEqual([13, 15]);
    expect(r.newWatermark).toBe(15);
  });

  it('dispatches nothing when nothing is new', () => {
    const r = nextDispatchSet([pr(4), pr(9)], 9);
    expect(r.toDispatch).toEqual([]);
    expect(r.newWatermark).toBe(9);
  });

  it('never moves the watermark backwards on a thin PR list', () => {
    // Pagination or eventual consistency can momentarily hide the newest PR;
    // that must not re-open history.
    const r = nextDispatchSet([pr(4)], 9);
    expect(r.toDispatch).toEqual([]);
    expect(r.newWatermark).toBe(9);
  });

  it('handles an empty list against an existing watermark', () => {
    const r = nextDispatchSet([], 9);
    expect(r.toDispatch).toEqual([]);
    expect(r.newWatermark).toBe(9);
  });
});

describe('parseWatermark', () => {
  it('reads a stored number', () => {
    expect(parseWatermark('42')).toBe(42);
  });
  it('treats null, empty, and junk as never-polled', () => {
    expect(parseWatermark(null)).toBeNull();
    expect(parseWatermark('')).toBeNull();
    expect(parseWatermark('  ')).toBeNull();
    expect(parseWatermark('not-a-number')).toBeNull();
  });
});

describe('parsePrUrl', () => {
  it('extracts owner, repo, and number from a PR url', () => {
    expect(parsePrUrl('https://github.com/acme/widgets/pull/128')).toEqual({
      owner: 'acme', repo: 'widgets', number: 128,
    });
  });
  it('tolerates trailing path segments', () => {
    expect(parsePrUrl('https://github.com/acme/widgets/pull/128/files')).toEqual({
      owner: 'acme', repo: 'widgets', number: 128,
    });
  });
  it('rejects what is not a GitHub PR url', () => {
    expect(parsePrUrl('https://github.com/acme/widgets')).toBeNull();
    expect(parsePrUrl('https://github.com/acme/widgets/issues/128')).toBeNull();
    expect(parsePrUrl('https://gitlab.com/acme/widgets/pull/128')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
  });
});

describe('renderPrReviewPrompt', () => {
  it('carries the PR identity and the bot mission', () => {
    const pull: PullSummary = {
      number: 7, title: 'Fix login redirect', state: 'open',
      headRef: 'fix/login', baseRef: 'main', author: 'octocat',
      createdAt: '2026-08-21T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z',
      url: 'https://github.com/acme/widgets/pull/7', draft: false,
    };
    const prompt = renderPrReviewPrompt('Review this PR for security issues.', pull);
    expect(prompt).toContain('PR #7: Fix login redirect');
    expect(prompt).toContain('https://github.com/acme/widgets/pull/7');
    expect(prompt).toContain('fix/login → main');
    expect(prompt).toContain('Review this PR for security issues.');
  });
});
