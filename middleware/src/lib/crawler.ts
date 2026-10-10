import { requirePublicBrowser } from './public-browser.js';
import { publicWebFetch, assertPublicWebTarget } from './public-web-fetch.js';
// Vision-LLM crawler. Drives the AgentCore Browser to load a starting URL,
// captures a screenshot, asks Nova Pro to extract a structured summary
// + discovered links, and uploads three artifacts per page (PNG screenshot,
// KB-ready markdown, raw Nova JSON) to S3. SPA mode also clicks JS-driven
// nav buttons by pixel coordinates to surface virtual routes.
//
// All exported names match the previous module so routes/* don't need edits.
// The shared shape contract lives in ./crawler-types.ts — keep this in sync.

import { randomUUID, createHash } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { agentcore } from '../providers/index.js';
import { appendJourneyStep, recordCapabilityEvent } from './invocations.js';
import { config } from '../config.js';
import { extractFromScreenshot } from './vision-extractor.js';
import { crawlSessionRows } from '../mock/ingest-crawls.js';
import { mockRestartMirror } from '../mock/restart-state.js';
import type {
  CrawlEvent,
  CrawlMode,
  CrawlPage,
  CrawlSession,
  DiscoveredLink,
} from './crawler-types.js';

// Re-export types from the contract so existing imports of CrawlPage/CrawlSession/
// CrawlEvent from this module keep working.
export type { CrawlEvent, CrawlMode, CrawlPage, CrawlSession, DiscoveredLink } from './crawler-types.js';

// ── Pricing (Nova Pro, mid-2026 rates) ────────────────────────────────────────
// $0.0008 per 1k input tokens, $0.0032 per 1k output tokens.
const PRICE_IN_PER_TOKEN = 0.0008 / 1000;
const PRICE_OUT_PER_TOKEN = 0.0032 / 1000;

function pageCost(tokensIn: number, tokensOut: number): number {
  return tokensIn * PRICE_IN_PER_TOKEN + tokensOut * PRICE_OUT_PER_TOKEN;
}

// ── In-memory registries ──────────────────────────────────────────────────────

type Subscriber = (ev: CrawlEvent) => void;

const _sessions = new Map<string, CrawlSession>();
const _subscribers = new Map<string, Set<Subscriber>>();
const _cancelFlags = new Set<string>();

// ── Mock seeding ──────────────────────────────────────────────────────────
//
// Unlike `crawl-targets.ts`/`ingest-scheduler.ts`, this module has no
// `init*()` entry point called from `index.ts` — `_sessions` is populated
// purely as a side effect of `startCrawl()`. So under mock the seed is
// applied lazily, on first read, rather than at boot: cheap to check on every
// call (`mockSeeded` is a flag, not a re-scan) and it needs no wiring into
// `index.ts`, which this fix does not own.
let mockSeeded = false;

function ensureMockSeeded(): void {
  if (!config.mock.aurora || mockSeeded) return;
  mockSeeded = true;
  for (const row of (mockRestartMirror('crawlSessions')?.map(([, row]) => row) as CrawlSession[] | undefined) ?? crawlSessionRows.rows()) {
    // Deep-ish copy: `pages` is the array callers push into during a live
    // run, and the fixture's own array must stay untouched so a reset can
    // rebuild from it.
    _sessions.set(row.id, { ...row, pages: row.pages.map((p) => ({ ...p })) });
  }
}

/**
 * Put the offline crawl-run history back to its seed.
 *
 * `_sessions` is a plain Map populated from a copy of the fixture's rows
 * (see `ensureMockSeeded`), so `registry.resetAll()` cannot reach it — the
 * same trap `rehydrateMockFleet` (`providers/devbox-fleet-store.ts`) closes
 * for the devbox fleet. Called from `routes/mock-control.ts`'s full reset,
 * per-fixture reset, and both scenario routes. No-op when Aurora is real.
 */
export function rehydrateMockCrawls(): number {
  if (!config.mock.aurora) return 0;
  _sessions.clear();
  mockSeeded = false;
  ensureMockSeeded();
  return _sessions.size;
}

function emit(crawlId: string, ev: CrawlEvent): void {
  const subs = _subscribers.get(crawlId);
  if (!subs) return;
  for (const s of subs) {
    try { s(ev); } catch (err) { console.warn('[crawler] subscriber threw:', (err as Error).message); }
  }
}

export function subscribeCrawl(crawlId: string, fn: Subscriber): () => void {
  const set = _subscribers.get(crawlId) ?? new Set();
  set.add(fn);
  _subscribers.set(crawlId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) _subscribers.delete(crawlId);
  };
}

export function getCrawl(crawlId: string): CrawlSession | null {
  ensureMockSeeded();
  return _sessions.get(crawlId) ?? null;
}

export function listCrawls(limit = 20): CrawlSession[] {
  ensureMockSeeded();
  return Array.from(_sessions.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function cancelCrawl(crawlId: string): boolean {
  ensureMockSeeded();
  if (!_sessions.has(crawlId)) return false;
  _cancelFlags.add(crawlId);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .toLowerCase() || 'page';
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

function safeRegex(pattern: string): RegExp | null {
  try { return new RegExp(pattern); } catch { return null; }
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12);
}

function decodeDataUrl(dataUrl: string): Buffer {
  // data:image/png;base64,XXX  →  Buffer of raw PNG bytes.
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}

function renderMarkdown(url: string, title: string, summary: string, mainText: string, crawledAt: string, crawlId: string): string {
  const heading = title || url;
  return `# ${heading}\n\n` +
    `Source: ${url}\n` +
    `Crawled: ${crawledAt}\n` +
    `Crawl: ${crawlId}\n\n` +
    (summary ? `## Summary\n\n${summary}\n\n` : '') +
    (mainText ? `## Content\n\n${mainText}\n` : '');
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface StartCrawlInput {
  startUrl: string;
  maxPages?: number;
  mode?: CrawlMode;
  includePattern?: string;
  sameOriginOnly?: boolean;
  label?: string;
  targetId?: string | null;
  scheduleId?: string | null;
}

export async function startCrawl(input: StartCrawlInput): Promise<CrawlSession> {
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? 10));
  const mode: CrawlMode = input.mode ?? 'browser';
  const includePattern = input.includePattern?.trim() || null;
  const sameOriginOnly = input.sameOriginOnly !== false;

  await assertPublicWebTarget(input.startUrl);
  if (mode !== 'fetch') await requirePublicBrowser();

  // HTTP crawls never create an unused browser session. Browser sessions
  // are closed in runLoop's finally block.
  const browser = mode === 'fetch' ? { sessionId: `fetch-${randomUUID()}` } : await agentcore.createBrowserSession({
    agentName: input.label ?? 'doc-crawler',
    url: input.startUrl,
  });

  const id = randomUUID();
  const crawl: CrawlSession = {
    id,
    sessionId: browser.sessionId,
    startUrl: input.startUrl,
    maxPages,
    mode,
    includePattern,
    sameOriginOnly,
    status: 'running',
    pages: [],
    queued: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    scheduleId: input.scheduleId ?? null,
    targetId: input.targetId ?? null,
    s3Prefix: `crawled/${id}`,
    totalScreenshotBytes: 0,
    totalMarkdownBytes: 0,
    estimatedCostUsd: 0,
  };
  _sessions.set(crawl.id, crawl);
  emit(crawl.id, { type: 'started', session: crawl });

  // Background loop; HTTP handler returns the initial session immediately.
  void runLoop(crawl).catch((err) => {
    console.warn('[crawler] loop threw:', (err as Error).message);
  });

  return crawl;
}

// ── Run loop ──────────────────────────────────────────────────────────────────

interface QueueItem {
  url: string;
  depth: number;
  parent: string | null;
}

async function runLoop(crawl: CrawlSession): Promise<void> {
  const s3 = new S3Client({ region: config.region });
  const bucket = config.foundation.documentsBucket;

  const visited = new Set<string>();
  const seenScreenshotHashes = new Set<string>();
  const queue: QueueItem[] = [{ url: crawl.startUrl, depth: 0, parent: null }];
  const startOrigin = safeOrigin(crawl.startUrl);
  const includeRegex = crawl.includePattern ? safeRegex(crawl.includePattern) : null;

  try {
    while (queue.length > 0 && crawl.pages.length < crawl.maxPages) {
      if (_cancelFlags.has(crawl.id)) {
        crawl.status = 'cancelled';
        crawl.completedAt = new Date().toISOString();
        _cancelFlags.delete(crawl.id);
        emit(crawl.id, { type: 'cancelled', session: crawl });
        return;
      }

      const job = queue.shift()!;
      if (visited.has(job.url)) continue;
      visited.add(job.url);
      crawl.queued = queue.length;

      const page = await processPage(crawl, job, s3, bucket, seenScreenshotHashes);
      crawl.pages.push(page);
      crawl.queued = queue.length;
      emit(crawl.id, { type: 'page', page, session: crawl });

      // Enqueue normal (non-SPA) discovered links.
      const remaining = crawl.maxPages - crawl.pages.length;
      if (remaining > 0) {
        for (const link of page.discoveredLinks) {
          if (link.isSpaLink) continue;
          const target = link.targetUrl;
          if (!target) continue;
          if (visited.has(target)) continue;
          if (queue.some((q) => q.url === target)) continue;
          if (crawl.sameOriginOnly && safeOrigin(target) !== startOrigin) continue;
          if (includeRegex) {
            try {
              if (!includeRegex.test(new URL(target).pathname)) continue;
            } catch { continue; }
          }
          queue.push({ url: target, depth: job.depth + 1, parent: job.url });
        }
      }

      // SPA traversal: click each isSpaLink with coordinates, screenshot,
      // and process the resulting "virtual" page if the content actually
      // changed.
      if (crawl.mode === 'browser_spa' && page.status === 'done') {
        await traverseSpaLinks(crawl, page, s3, bucket, seenScreenshotHashes);
      }
    }

    if (crawl.status === 'running') {
      crawl.status = 'completed';
      crawl.completedAt = new Date().toISOString();
      emit(crawl.id, { type: 'completed', session: crawl });
    }
  } catch (err) {
    crawl.status = 'failed';
    crawl.error = (err as Error).message;
    crawl.completedAt = new Date().toISOString();
    emit(crawl.id, { type: 'failed', session: crawl, error: crawl.error });
  } finally {
    try { if (crawl.mode !== 'fetch') await agentcore.closeBrowserSession(crawl.sessionId); } catch { /* best effort */ }
  }
}

// ── Per-page processing ───────────────────────────────────────────────────────

function makePage(url: string, depth: number, parent: string | null): CrawlPage {
  return {
    url,
    title: '',
    depth,
    parentUrl: parent,
    crawledAt: new Date().toISOString(),
    status: 'pending',
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
  };
}

function setStatus(crawl: CrawlSession, page: CrawlPage, status: CrawlPage['status']): void {
  page.status = status;
  emit(crawl.id, { type: 'page-status', page, session: crawl });
}

async function processPage(
  crawl: CrawlSession,
  job: QueueItem,
  s3: S3Client,
  bucket: string,
  seenHashes: Set<string>,
): Promise<CrawlPage> {
  const page = makePage(job.url, job.depth, job.parent);

  try {
    if (crawl.mode === 'fetch') {
      await runFetchMode(page, job.url);
    } else {
      // browser + browser_spa share the same per-page pipeline; SPA-specific
      // traversal happens in runLoop after the page is emitted.
      await runBrowserMode(crawl, page, job.url, s3, bucket, seenHashes);
    }
  } catch (err) {
    page.error = (err as Error).message;
    page.status = 'failed';
  }

  // Capabilities-page event log (kept for back-compat).
  appendJourneyStep(crawl.sessionId, {
    startedAt: page.crawledAt,
    url: page.url,
    pageTitle: page.title,
    textSnippet: page.summary || page.mainText.slice(0, 500),
  });

  recordCapabilityEvent({
    id: randomUUID(),
    kind: 'browser_navigate',
    startedAt: page.crawledAt,
    durationMs: Date.now() - new Date(page.crawledAt).getTime(),
    sessionId: crawl.sessionId,
    detail: {
      url: page.url,
      title: page.title,
      source: 'crawl',
      crawlId: crawl.id,
      mode: crawl.mode,
    },
    ok: !page.error,
    ...(page.error ? { error: page.error } : {}),
  });

  return page;
}

// ── 'fetch' mode: cheap server-side text scrape ───────────────────────────────

async function runFetchMode(page: CrawlPage, url: string): Promise<void> {
  page.status = 'navigating';
  let html = '';
  try {
    const res = await publicWebFetch(url, {
      headers: { 'User-Agent': 'OrgIQ-Crawler/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      page.error = `HTTP ${res.status}`;
      page.status = 'failed';
      return;
    }
    html = await res.text();
  } catch (err) {
    page.error = (err as Error).message;
    page.status = 'failed';
    return;
  }

  page.status = 'extracting';
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  page.title = titleMatch ? titleMatch[1]!.trim() : '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50000);
  page.mainText = text;
  page.contentLength = text.length;
  page.summary = text.slice(0, 500);

  // Extract absolute links so the BFS still has somewhere to go.
  const linkRe = /href=["']([^"']+)["']/gi;
  const links: DiscoveredLink[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      const abs = new URL(m[1]!, url).href;
      if (!/^https?:\/\//.test(abs)) continue;
      if (abs.includes('#')) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      links.push({ label: '', targetUrl: abs, isSpaLink: false });
      if (links.length >= 50) break;
    } catch { /* skip */ }
  }
  page.discoveredLinks = links;
  page.status = 'done';
}

// ── 'browser' + 'browser_spa' mode: AgentCore Browser + Nova Pro ──────────────

async function runBrowserMode(
  crawl: CrawlSession,
  page: CrawlPage,
  url: string,
  s3: S3Client,
  bucket: string,
  seenHashes: Set<string>,
): Promise<void> {
  setStatus(crawl, page, 'navigating');
  await assertPublicWebTarget(url);
  const nav = await agentcore.navigateBrowser(crawl.sessionId, url);
  if (!nav) {
    page.error = 'navigate failed';
    page.status = 'failed';
    return;
  }

  const shot = await agentcore.screenshotBrowser(crawl.sessionId);
  if (!shot?.imageDataUrl) {
    page.error = 'screenshot failed';
    page.status = 'failed';
    return;
  }
  const pngBytes = decodeDataUrl(shot.imageDataUrl);
  page.screenshotBytes = pngBytes.length;
  const hash = hashBytes(pngBytes);
  seenHashes.add(hash);

  setStatus(crawl, page, 'extracting');
  const vision = await extractFromScreenshot(pngBytes, url);
  page.title = vision.title;
  page.summary = vision.summary;
  page.mainText = vision.mainText;
  page.discoveredLinks = vision.discoveredLinks;
  page.contentLength = vision.mainText.length;
  page.visionTokensIn = vision.tokensIn;
  page.visionTokensOut = vision.tokensOut;
  page.visionLatencyMs = vision.latencyMs;

  // Roll cost into the session aggregate.
  crawl.estimatedCostUsd = +(crawl.estimatedCostUsd + pageCost(vision.tokensIn, vision.tokensOut)).toFixed(6);

  if (bucket) {
    setStatus(crawl, page, 'uploading');
    await uploadArtifacts(crawl, page, pngBytes, vision, s3, bucket);
  }

  setStatus(crawl, page, 'done');
}

// ── SPA traversal ─────────────────────────────────────────────────────────────

async function traverseSpaLinks(
  crawl: CrawlSession,
  parentPage: CrawlPage,
  s3: S3Client,
  bucket: string,
  seenHashes: Set<string>,
): Promise<void> {
  const candidates = parentPage.discoveredLinks.filter(
    (l) => l.isSpaLink && typeof l.clickX === 'number' && typeof l.clickY === 'number',
  );
  let virtualCounter = 0;

  for (const link of candidates) {
    if (crawl.pages.length >= crawl.maxPages) break;
    if (_cancelFlags.has(crawl.id)) return;

    const x = link.clickX!;
    const y = link.clickY!;

    // Re-navigate to the parent URL first so each SPA click starts from a
    // known baseline. Avoids cascading state from previous clicks.
    await agentcore.navigateBrowser(crawl.sessionId, parentPage.url);

    const clicked = await agentcore.clickBrowser(crawl.sessionId, x, y);
    if (!clicked) continue;

    // Give the SPA a moment to re-render.
    await new Promise((r) => setTimeout(r, 2000));

    const shot = await agentcore.screenshotBrowser(crawl.sessionId);
    if (!shot?.imageDataUrl) continue;
    const pngBytes = decodeDataUrl(shot.imageDataUrl);
    const hash = hashBytes(pngBytes);
    if (seenHashes.has(hash)) continue; // duplicate content, skip
    seenHashes.add(hash);

    // SPA route synthetic URL — Nova can't always read the actual route from
    // the screenshot, so anchor to the parent URL plus a virtual fragment so
    // downstream artifacts have unique keys.
    virtualCounter += 1;
    const virtualUrl = `${parentPage.url}#virtual-${String(virtualCounter).padStart(2, '0')}-${slugify(link.label)}`;

    const virtualPage = makePage(virtualUrl, parentPage.depth + 1, parentPage.url);
    virtualPage.screenshotBytes = pngBytes.length;
    setStatus(crawl, virtualPage, 'extracting');

    const vision = await extractFromScreenshot(pngBytes, virtualUrl);
    virtualPage.title = vision.title || link.label;
    virtualPage.summary = vision.summary;
    virtualPage.mainText = vision.mainText;
    virtualPage.discoveredLinks = vision.discoveredLinks;
    virtualPage.contentLength = vision.mainText.length;
    virtualPage.visionTokensIn = vision.tokensIn;
    virtualPage.visionTokensOut = vision.tokensOut;
    virtualPage.visionLatencyMs = vision.latencyMs;
    crawl.estimatedCostUsd = +(crawl.estimatedCostUsd + pageCost(vision.tokensIn, vision.tokensOut)).toFixed(6);

    if (bucket) {
      setStatus(crawl, virtualPage, 'uploading');
      await uploadArtifacts(crawl, virtualPage, pngBytes, vision, s3, bucket);
    }
    setStatus(crawl, virtualPage, 'done');

    appendJourneyStep(crawl.sessionId, {
      startedAt: virtualPage.crawledAt,
      url: virtualPage.url,
      pageTitle: virtualPage.title,
      textSnippet: virtualPage.summary,
    });

    crawl.pages.push(virtualPage);
    emit(crawl.id, { type: 'page', page: virtualPage, session: crawl });
  }
}

// ── S3 artifact upload ────────────────────────────────────────────────────────

async function uploadArtifacts(
  crawl: CrawlSession,
  page: CrawlPage,
  pngBytes: Buffer,
  vision: { title: string; summary: string; mainText: string; discoveredLinks: DiscoveredLink[]; tokensIn: number; tokensOut: number; latencyMs: number },
  s3: S3Client,
  bucket: string,
): Promise<void> {
  const seq = String(crawl.pages.length).padStart(3, '0');
  const slug = slugify(page.url);
  const prefix = crawl.s3Prefix;
  const screenshotKey = `${prefix}/screenshots/${seq}-${slug}.png`;
  const markdownKey = `${prefix}/${seq}-${slug}.md`;
  const analysisKey = `${prefix}/analysis/${seq}-${slug}.json`;

  const markdown = renderMarkdown(page.url, vision.title, vision.summary, vision.mainText, page.crawledAt, crawl.id);
  const markdownBytes = Buffer.byteLength(markdown, 'utf8');
  const analysis = JSON.stringify(
    {
      url: page.url,
      crawledAt: page.crawledAt,
      crawlId: crawl.id,
      title: vision.title,
      summary: vision.summary,
      mainText: vision.mainText,
      discoveredLinks: vision.discoveredLinks,
      tokensIn: vision.tokensIn,
      tokensOut: vision.tokensOut,
      latencyMs: vision.latencyMs,
    },
    null,
    2,
  );

  const metadata = {
    'source-url': page.url.slice(0, 1024),
    'crawl-id': crawl.id,
    'depth': String(page.depth),
  };

  const uploads = await Promise.allSettled([
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: screenshotKey,
      Body: pngBytes,
      ContentType: 'image/png',
      Metadata: metadata,
    })),
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: markdownKey,
      Body: markdown,
      ContentType: 'text/markdown',
      Metadata: metadata,
    })),
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: analysisKey,
      Body: analysis,
      ContentType: 'application/json',
      Metadata: metadata,
    })),
  ]);

  const [shotRes, mdRes, jsonRes] = uploads;
  if (shotRes.status === 'fulfilled') {
    page.s3ScreenshotKey = screenshotKey;
    crawl.totalScreenshotBytes += pngBytes.length;
  } else {
    console.warn('[crawler] screenshot upload failed:', (shotRes.reason as Error).message);
  }
  if (mdRes.status === 'fulfilled') {
    page.s3MarkdownKey = markdownKey;
    crawl.totalMarkdownBytes += markdownBytes;
  } else {
    console.warn('[crawler] markdown upload failed:', (mdRes.reason as Error).message);
  }
  if (jsonRes.status === 'fulfilled') {
    page.s3AnalysisKey = analysisKey;
  } else {
    console.warn('[crawler] analysis upload failed:', (jsonRes.reason as Error).message);
  }

  if (!page.s3MarkdownKey && !page.s3ScreenshotKey && !page.s3AnalysisKey) {
    page.error = 's3 upload failed';
  }
}
