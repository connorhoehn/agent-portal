// Shared contract for the vision-LLM crawler. Imported by crawler.ts,
// ingest.ts (routes), crawl-targets.ts, and consumed (via JSON shape) by the
// portal IngestPage. Treat field renames here as breaking changes.

export type CrawlMode = 'fetch' | 'browser' | 'browser_spa';

export type PageStatus =
  | 'pending'
  | 'navigating'
  | 'extracting'
  | 'uploading'
  | 'done'
  | 'failed';

export interface DiscoveredLink {
  /** Visible link text the LLM identified (button label, menu item, etc.) */
  label: string;
  /** Resolved absolute href if extractable; null for pure SPA links */
  targetUrl: string | null;
  /** Pixel coordinates for mouseClick when isSpaLink — Nova returns these */
  clickX?: number;
  clickY?: number;
  /** True when the link is JS-driven (href is "#", "javascript:", or missing) */
  isSpaLink: boolean;
}

export interface CrawlPage {
  // Identity
  url: string;
  title: string;
  depth: number;
  parentUrl: string | null;
  crawledAt: string;
  status: PageStatus;
  error: string | null;

  // S3 artifacts — null until upload completes
  s3ScreenshotKey: string | null;  // crawled/{id}/screenshots/000-{slug}.png
  s3MarkdownKey: string | null;    // crawled/{id}/000-{slug}.md  (KB-bound)
  s3AnalysisKey: string | null;    // crawled/{id}/analysis/000-{slug}.json

  // Nova Pro vision output
  summary: string;
  mainText: string;
  discoveredLinks: DiscoveredLink[];

  // Metrics
  contentLength: number;
  screenshotBytes: number;
  visionTokensIn: number;
  visionTokensOut: number;
  visionLatencyMs: number;
  kbIngestedAt: string | null;
}

export interface CrawlSession {
  id: string;
  sessionId: string;          // underlying AgentCore browser sessionId
  startUrl: string;
  maxPages: number;
  mode: CrawlMode;
  sameOriginOnly: boolean;
  includePattern: string | null;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  pages: CrawlPage[];
  queued: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;

  // New persistence + cost tracking
  scheduleId: string | null;            // links to CrawlTarget if scheduled
  targetId: string | null;              // CrawlTarget that triggered this run
  s3Prefix: string;                     // crawled/{id}
  totalScreenshotBytes: number;
  totalMarkdownBytes: number;
  estimatedCostUsd: number;
}

export interface CrawlTarget {
  id: string;
  label: string;
  startUrl: string;
  maxPages: number;
  mode: CrawlMode;
  includePattern: string | null;
  sameOriginOnly: boolean;
  cronExpr: string | null;              // null = on-demand only
  enabled: boolean;
  createdAt: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastStatus: CrawlSession['status'] | null;
  nextRunAt: string | null;             // computed from cronExpr
}

export type CrawlEvent =
  | { type: 'started';    session: CrawlSession }
  | { type: 'page';       page: CrawlPage; session: CrawlSession }
  | { type: 'page-status'; page: CrawlPage; session: CrawlSession }
  | { type: 'completed';  session: CrawlSession }
  | { type: 'failed';     session: CrawlSession; error: string }
  | { type: 'cancelled';  session: CrawlSession };

// ── Nova Pro vision extractor contract ──────────────────────────────────────
//
// The vision extractor takes a PNG screenshot + page URL and returns this
// shape. The crawler folds it into the CrawlPage record.

export interface VisionExtractionResult {
  title: string;
  summary: string;
  mainText: string;
  discoveredLinks: DiscoveredLink[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

// ── Storage breakdown response shape (for GET /api/ingest/storage) ──────────

export interface StorageBreakdown {
  bucket: string;
  totalObjects: number;
  totalBytes: number;
  byType: Array<{ extension: string; count: number; bytes: number }>;
  byPrefix: Array<{ prefix: string; count: number; bytes: number }>;
  /**
   * True when the S3 scan behind `totalObjects`/`byType`/`byPrefix` failed —
   * those fields are then a stale 0, not a real "nothing stored". Absent
   * (rather than false) on a healthy read, matching the wire's `degraded`
   * convention.
   */
  s3ScanFailed?: true;
  kb: {
    /**
     * Distinct documents the vector store actually holds — null when it could
     * not be counted.
     *
     * Null rather than 0 for the reason the reconcile page learned the hard
     * way: on this surface "we could not count" and "there are none" are the
     * failure and the finding, and rendering them as the same number makes the
     * page unable to report the thing it exists to report.
     */
    totalDocuments: number | null;
    lastIngestedAt: string | null;
  };
}
