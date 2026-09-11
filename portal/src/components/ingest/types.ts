// Frontend-side mirror of middleware/src/lib/crawler-types.ts.
// Keep these structurally aligned; changes there are breaking.

export type CrawlMode = 'fetch' | 'browser' | 'browser_spa';

export type PageStatus =
  | 'pending'
  | 'navigating'
  | 'extracting'
  | 'uploading'
  | 'done'
  | 'failed';

export interface DiscoveredLink {
  label: string;
  targetUrl: string | null;
  clickX?: number;
  clickY?: number;
  isSpaLink: boolean;
}

export interface CrawlPage {
  url: string;
  title: string;
  depth: number;
  parentUrl: string | null;
  crawledAt: string;
  status: PageStatus;
  error: string | null;
  s3ScreenshotKey: string | null;
  s3MarkdownKey: string | null;
  s3AnalysisKey: string | null;
  summary: string;
  mainText: string;
  discoveredLinks: DiscoveredLink[];
  contentLength: number;
  screenshotBytes: number;
  visionTokensIn: number;
  visionTokensOut: number;
  visionLatencyMs: number;
  kbIngestedAt: string | null;
}

export type CrawlStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface CrawlSession {
  id: string;
  sessionId: string;
  startUrl: string;
  maxPages: number;
  mode: CrawlMode;
  sameOriginOnly: boolean;
  includePattern: string | null;
  status: CrawlStatus;
  pages: CrawlPage[];
  queued: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  scheduleId: string | null;
  targetId: string | null;
  s3Prefix: string;
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
  cronExpr: string | null;
  enabled: boolean;
  createdAt: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastStatus: CrawlStatus | null;
  nextRunAt: string | null;
}

export type CrawlEvent =
  | { type: 'started';     session: CrawlSession }
  | { type: 'page';        page: CrawlPage; session: CrawlSession }
  | { type: 'page-status'; page: CrawlPage; session: CrawlSession }
  | { type: 'completed';   session: CrawlSession }
  | { type: 'failed';      session: CrawlSession; error: string }
  | { type: 'cancelled';   session: CrawlSession };

export interface StorageBreakdown {
  bucket: string;
  totalObjects: number;
  totalBytes: number;
  byType: Array<{ extension: string; count: number; bytes: number }>;
  byPrefix: Array<{ prefix: string; count: number; bytes: number }>;
  kb: {
    /** Null when the vector store could not be counted — not zero. */
    totalDocuments: number | null;
    lastIngestedAt: string | null;
  };
}

// ── Shared style helpers + utilities used across ingest components ──────────

export const CRAWL_STATUS_TONE: Record<CrawlStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  completed: 'success',
  running: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

export const PAGE_STATUS_TONE: Record<PageStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending: 'neutral',
  navigating: 'warning',
  extracting: 'warning',
  uploading: 'warning',
  done: 'success',
  failed: 'danger',
};

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

export function durationOf(session: { startedAt: string; completedAt: string | null }): number {
  const start = new Date(session.startedAt).getTime();
  const end = session.completedAt ? new Date(session.completedAt).getTime() : Date.now();
  return end - start;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}
