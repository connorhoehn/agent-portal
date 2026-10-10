// Crawl run history — the rows "Ingest runs" (`/admin/ingest/history`) lists,
// seeded for `dev:mock`.
//
// WHY THIS EXISTS. `lib/crawler.ts` keeps sessions in a plain `_sessions`
// Map populated only by `startCrawl()`, with no mock branch anywhere — so
// `listCrawls()` always started empty offline and `GET /api/ingest/crawls`
// answered `{"crawls":[]}`. Same contract-rule-5 shape as the crawl targets
// (`ingest-crawl-targets.ts`) and the schedules (`ingest-schedules.ts`).
//
// COHERENCE. Every `targetId`/`scheduleId` pair here names a real row in
// `ingest-crawl-targets.ts`'s `crawlTargetRows`, except crawl-mock-0005, a
// deliberately ad-hoc run (started by hand from the Upload/Crawl page, not by
// a target) — `targetId: null` is a real, reachable state (`startCrawl` is
// called with no `targetId` from `POST /ingest/crawl`), so the history page
// has to render "no target" at least once rather than assuming every row
// belongs to one.
//
// STATE COVERAGE. The four terminal shapes `CrawlSession.status` can be in,
// so the history page's per-status rendering (icon, retry affordance,
// duration) is exercised rather than five rows in the one state that happens
// to be easiest to write:
//   crawl-mock-0001  completed  — a clean multi-page run.
//   crawl-mock-0002  failed     — died on a page-level HTTP error.
//   crawl-mock-0003  cancelled  — stopped mid-run with pages still queued.
//   crawl-mock-0004  running    — currently in flight (the newest by far).
//   crawl-mock-0005  completed  — the ad-hoc, no-target run.

import { clock, defineFixture } from './core/index.js';
import type { CrawlPage, CrawlSession } from '../lib/crawler-types.js';

function page(overrides: Partial<CrawlPage> & Pick<CrawlPage, 'url' | 'crawledAt'>): CrawlPage {
  return {
    title: '',
    depth: 0,
    parentUrl: null,
    status: 'done',
    error: null,
    s3ScreenshotKey: null,
    s3MarkdownKey: null,
    s3AnalysisKey: null,
    summary: '',
    mainText: '',
    discoveredLinks: [],
    contentLength: 0,
    screenshotBytes: 0,
    visionTokensIn: 0,
    visionTokensOut: 0,
    visionLatencyMs: 0,
    kbIngestedAt: null,
    ...overrides,
  };
}

const artifactKeys = (crawlId: string, seq: string, slug: string) => ({
  s3ScreenshotKey: `crawled/${crawlId}/screenshots/${seq}-${slug}.png`,
  s3MarkdownKey: `crawled/${crawlId}/${seq}-${slug}.md`,
  s3AnalysisKey: `crawled/${crawlId}/analysis/${seq}-${slug}.json`,
});

function seedCrawls(): CrawlSession[] {
  // ── crawl-mock-0001 — completed, three pages, triggered by target-0001 ──
  const c1Id = 'crawl-mock-0001';
  const c1Started = clock.daysAgo(2);
  const c1Pages: CrawlPage[] = [
    page({
      url: 'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
      crawledAt: c1Started, title: 'Welcome - AWS Well-Architected Framework',
      summary: 'Overview of the six pillars of the Well-Architected Framework.',
      mainText: 'The AWS Well-Architected Framework helps you understand the pros and cons of decisions you make while building systems on AWS.',
      contentLength: 1240, screenshotBytes: 214_000, visionTokensIn: 1800, visionTokensOut: 420, visionLatencyMs: 2100,
      discoveredLinks: [{ label: 'Operational Excellence Pillar', targetUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html', isSpaLink: false }],
      ...artifactKeys(c1Id, '000', 'docs-aws-amazon-com-wellarchitected'),
    }),
    page({
      url: 'https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html',
      crawledAt: c1Started, depth: 1, parentUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
      title: 'Operational Excellence Pillar', summary: 'Practices for running and monitoring systems to deliver business value.',
      mainText: 'The Operational Excellence pillar includes the ability to run and monitor systems to deliver business value.',
      contentLength: 980, screenshotBytes: 198_000, visionTokensIn: 1650, visionTokensOut: 380, visionLatencyMs: 1950,
      ...artifactKeys(c1Id, '001', 'docs-aws-amazon-com-wellarchitected-operational'),
    }),
    page({
      url: 'https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html',
      crawledAt: c1Started, depth: 1, parentUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
      title: 'Security Pillar', summary: 'Practices for protecting information, systems and assets.',
      mainText: 'The Security pillar includes the ability to protect information, systems, and assets while delivering business value.',
      contentLength: 1050, screenshotBytes: 205_000, visionTokensIn: 1720, visionTokensOut: 400, visionLatencyMs: 2020,
      ...artifactKeys(c1Id, '002', 'docs-aws-amazon-com-wellarchitected-security'),
    }),
  ];
  const c1TotalShot = c1Pages.reduce((s, p) => s + p.screenshotBytes, 0);
  const c1TotalMd = c1Pages.reduce((s, p) => s + p.contentLength, 0);
  const c1Cost = c1Pages.reduce((s, p) => s + (p.visionTokensIn * 0.0008 + p.visionTokensOut * 0.0032) / 1000, 0);

  // ── crawl-mock-0002 — failed on the first page, triggered by target-0002 ──
  const c2Id = 'crawl-mock-0002';
  const c2Started = clock.hoursAgo(20);
  const c2Pages: CrawlPage[] = [
    page({
      url: 'https://wiki.internal.example.com/engineering', crawledAt: c2Started,
      status: 'failed', error: 'HTTP 503',
    }),
  ];

  // ── crawl-mock-0003 — cancelled mid-run, triggered by target-0003 ──
  const c3Id = 'crawl-mock-0003';
  const c3Started = clock.daysAgo(5);
  const c3Pages: CrawlPage[] = [
    page({
      url: 'https://changelog.example.com', crawledAt: c3Started,
      title: 'Changelog', summary: 'Recent product releases.', mainText: 'v4.2.0 — released this week.',
      contentLength: 320, screenshotBytes: 88_000, visionTokensIn: 900, visionTokensOut: 210, visionLatencyMs: 1400,
      discoveredLinks: [{ label: 'Load more', targetUrl: null, isSpaLink: true, clickX: 640, clickY: 812 }],
      ...artifactKeys(c3Id, '000', 'changelog-example-com'),
    }),
  ];

  // ── crawl-mock-0004 — RUNNING right now, triggered by target-0001 ──
  const c4Id = 'crawl-mock-0004';
  const c4Started = clock.hoursAgo(0.2);
  const c4Pages: CrawlPage[] = [
    page({
      url: 'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
      crawledAt: c4Started, title: 'Welcome - AWS Well-Architected Framework',
      summary: 'Overview of the six pillars of the Well-Architected Framework.',
      mainText: 'The AWS Well-Architected Framework helps you understand the pros and cons of decisions you make while building systems on AWS.',
      contentLength: 1240, screenshotBytes: 214_000, visionTokensIn: 1800, visionTokensOut: 420, visionLatencyMs: 2050,
      discoveredLinks: [{ label: 'Reliability Pillar', targetUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html', isSpaLink: false }],
      ...artifactKeys(c4Id, '000', 'docs-aws-amazon-com-wellarchitected'),
    }),
  ];

  // ── crawl-mock-0005 — completed, ad-hoc (no target) ──
  const c5Id = 'crawl-mock-0005';
  const c5Started = clock.daysAgo(9);
  const c5Pages: CrawlPage[] = [
    page({
      url: 'https://status.example.com/history', crawledAt: c5Started,
      title: 'Status history', summary: 'Past incidents and maintenance windows.',
      mainText: 'No incidents reported in the last 90 days.', contentLength: 410, screenshotBytes: 71_000,
      visionTokensIn: 780, visionTokensOut: 190, visionLatencyMs: 1180,
      ...artifactKeys(c5Id, '000', 'status-example-com-history'),
    }),
  ];

  return [
    {
      id: c1Id, sessionId: 'browser-mock-0001', startUrl: c1Pages[0]!.url, maxPages: 25, mode: 'browser',
      sameOriginOnly: true, includePattern: '^(/wellarchitected)(/|$)', status: 'completed', pages: c1Pages,
      queued: 0, startedAt: c1Started, completedAt: clock.daysAgo(2), error: null,
      scheduleId: 'target-mock-0001', targetId: 'target-mock-0001', s3Prefix: `crawled/${c1Id}`,
      totalScreenshotBytes: c1TotalShot, totalMarkdownBytes: c1TotalMd, estimatedCostUsd: +c1Cost.toFixed(6),
    },
    {
      id: c2Id, sessionId: 'browser-mock-0002', startUrl: 'https://wiki.internal.example.com/engineering',
      maxPages: 40, mode: 'fetch', sameOriginOnly: true, includePattern: null, status: 'failed', pages: c2Pages,
      queued: 0, startedAt: c2Started, completedAt: c2Started, error: 'HTTP 503',
      scheduleId: 'target-mock-0002', targetId: 'target-mock-0002', s3Prefix: `crawled/${c2Id}`,
      totalScreenshotBytes: 0, totalMarkdownBytes: 0, estimatedCostUsd: 0,
    },
    {
      id: c3Id, sessionId: 'browser-mock-0003', startUrl: 'https://changelog.example.com', maxPages: 15,
      mode: 'browser_spa', sameOriginOnly: true, includePattern: null, status: 'cancelled', pages: c3Pages,
      // Cancelled with pages still queued — that is what "cancelled" means on
      // this page, distinct from "completed" hitting maxPages exactly.
      queued: 6, startedAt: c3Started, completedAt: c3Started, error: null,
      scheduleId: 'target-mock-0003', targetId: 'target-mock-0003', s3Prefix: `crawled/${c3Id}`,
      totalScreenshotBytes: c3Pages[0]!.screenshotBytes, totalMarkdownBytes: c3Pages[0]!.contentLength,
      estimatedCostUsd: +((c3Pages[0]!.visionTokensIn * 0.0008 + c3Pages[0]!.visionTokensOut * 0.0032) / 1000).toFixed(6),
    },
    {
      id: c4Id, sessionId: 'browser-mock-0004', startUrl: c4Pages[0]!.url, maxPages: 25, mode: 'browser',
      sameOriginOnly: true, includePattern: '^(/wellarchitected)(/|$)', status: 'running', pages: c4Pages,
      queued: 3, startedAt: c4Started, completedAt: null, error: null,
      scheduleId: 'target-mock-0001', targetId: 'target-mock-0001', s3Prefix: `crawled/${c4Id}`,
      totalScreenshotBytes: c4Pages[0]!.screenshotBytes, totalMarkdownBytes: c4Pages[0]!.contentLength,
      estimatedCostUsd: +((c4Pages[0]!.visionTokensIn * 0.0008 + c4Pages[0]!.visionTokensOut * 0.0032) / 1000).toFixed(6),
    },
    {
      id: c5Id, sessionId: 'browser-mock-0005', startUrl: 'https://status.example.com/history', maxPages: 5,
      mode: 'browser', sameOriginOnly: true, includePattern: null, status: 'completed', pages: c5Pages,
      queued: 0, startedAt: c5Started, completedAt: clock.daysAgo(9), error: null,
      scheduleId: null, targetId: null, s3Prefix: `crawled/${c5Id}`,
      totalScreenshotBytes: c5Pages[0]!.screenshotBytes, totalMarkdownBytes: c5Pages[0]!.contentLength,
      estimatedCostUsd: +((c5Pages[0]!.visionTokensIn * 0.0008 + c5Pages[0]!.visionTokensOut * 0.0032) / 1000).toFixed(6),
    },
  ];
}

/**
 * The offline crawl-run history.
 *
 * `empty` is the honest state before any crawl — manual or scheduled — has
 * ever run.
 */
export const crawlSessionRows = defineFixture<CrawlSession>({
  key: 'ingest-crawls',
  scenarios: {
    default: seedCrawls,
    empty: () => [],
  },
});

/**
 * The image `GET /api/ingest/crawl/:id/page/:idx/screenshot` serves under
 * MOCK_AURORA for any page that carries an `s3ScreenshotKey`. Offline there is
 * no documents bucket to proxy, so every listed screenshot resolves to this
 * one fixed grey 8x8 PNG instead of 404ing. A page with a null key still 404s.
 */
export const MOCK_SCREENSHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4ceYSVsQwtCQA972ZgWOUTpoAAAAASUVORK5CYII=',
  'base64',
);
