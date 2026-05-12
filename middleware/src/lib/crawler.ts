// Doc-discovery crawler. BFS over a starting URL with depth/page caps, using
// the existing AgentCore Browser CDP session for navigation, screenshot, and
// link extraction. Extracted page text is uploaded to the documents S3 bucket
// so the existing KB ingestion pipeline can index it.

import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { agentcore } from '../providers/index.js';
import { appendJourneyStep, recordCapabilityEvent } from './invocations.js';
import { config } from '../config.js';

// AgentCore Browser doesn't expose CDP for JS evaluation. Fetch the page
// server-side to extract title, body text, and links instead.
async function fetchPageContent(url: string): Promise<{ title: string; text: string; links: string[] }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OrgIQ-Crawler/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { title: '', text: '', links: [] };
    const html = await res.text();
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1]!.trim() : '';
    // Strip tags and collapse whitespace for body text
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
    // Extract absolute links
    const linkRe = /href=["']([^"']+)["']/gi;
    const links: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
      try {
        const abs = new URL(m[1]!, url).href;
        if ((abs.startsWith('http://') || abs.startsWith('https://')) && !abs.includes('#') && !links.includes(abs)) {
          links.push(abs);
          if (links.length >= 200) break;
        }
      } catch { /* skip invalid URLs */ }
    }
    return { title, text, links };
  } catch (err) {
    console.warn('[crawler] fetchPageContent failed:', (err as Error).message);
    return { title: '', text: '', links: [] };
  }
}

export interface CrawlPage {
  url: string;
  title: string;
  textSnippet: string;     // first ~500 chars (for UI)
  contentLength: number;   // full extracted length
  depth: number;
  parentUrl: string | null;
  linksFound: string[];    // outbound links discovered on this page
  s3Key: string | null;    // populated after successful upload
  screenshotTaken: boolean;
  crawledAt: string;
  error: string | null;
}

export interface CrawlSession {
  id: string;
  sessionId: string;            // underlying browser sessionId
  startUrl: string;
  maxPages: number;
  includePattern: string | null;
  sameOriginOnly: boolean;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  pages: CrawlPage[];
  queued: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export type CrawlEvent =
  | { type: 'started';   session: CrawlSession }
  | { type: 'page';      page: CrawlPage; session: CrawlSession }
  | { type: 'completed'; session: CrawlSession }
  | { type: 'failed';    session: CrawlSession; error: string }
  | { type: 'cancelled'; session: CrawlSession };

type Subscriber = (ev: CrawlEvent) => void;

const _sessions = new Map<string, CrawlSession>();
const _subscribers = new Map<string, Set<Subscriber>>();
const _cancelFlags = new Set<string>();


function slugify(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .toLowerCase() || 'page';
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
  return _sessions.get(crawlId) ?? null;
}

export function listCrawls(limit = 20): CrawlSession[] {
  return Array.from(_sessions.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function cancelCrawl(crawlId: string): boolean {
  if (!_sessions.has(crawlId)) return false;
  _cancelFlags.add(crawlId);
  return true;
}

export interface StartCrawlInput {
  startUrl: string;
  maxPages?: number;
  includePattern?: string;
  sameOriginOnly?: boolean;
  label?: string;
}

export async function startCrawl(input: StartCrawlInput): Promise<CrawlSession> {
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? 10));
  const includePattern = input.includePattern?.trim() || null;
  const sameOriginOnly = input.sameOriginOnly !== false;

  const browser = await agentcore.createBrowserSession({
    agentName: input.label ?? 'doc-crawler',
    url: input.startUrl,
  });

  const crawl: CrawlSession = {
    id: randomUUID(),
    sessionId: browser.sessionId,
    startUrl: input.startUrl,
    maxPages,
    includePattern,
    sameOriginOnly,
    status: 'running',
    pages: [],
    queued: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  _sessions.set(crawl.id, crawl);
  emit(crawl.id, { type: 'started', session: crawl });

  // Run the loop in the background. The HTTP handler returns the initial session
  // immediately and clients subscribe to /stream for progress.
  void runLoop(crawl).catch((err) => {
    console.warn('[crawler] loop threw:', (err as Error).message);
  });

  return crawl;
}

async function runLoop(crawl: CrawlSession): Promise<void> {
  const s3 = new S3Client({ region: config.region });
  const bucket = config.foundation.documentsBucket;
  const prefix = `crawled/${crawl.id}`;

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number; parent: string | null }> = [
    { url: crawl.startUrl, depth: 0, parent: null },
  ];
  const startOrigin = safeOrigin(crawl.startUrl);
  const includeRegex = crawl.includePattern ? safeRegex(crawl.includePattern) : null;

  try {
    while (queue.length > 0 && crawl.pages.length < crawl.maxPages) {
      if (_cancelFlags.has(crawl.id)) {
        crawl.status = 'cancelled';
        crawl.completedAt = new Date().toISOString();
        _cancelFlags.delete(crawl.id);
        emit(crawl.id, { type: 'cancelled', session: crawl });
        break;
      }

      const job = queue.shift()!;
      if (visited.has(job.url)) continue;
      visited.add(job.url);
      crawl.queued = queue.length;

      const page: CrawlPage = {
        url: job.url,
        title: '',
        textSnippet: '',
        contentLength: 0,
        depth: job.depth,
        parentUrl: job.parent,
        linksFound: [],
        s3Key: null,
        screenshotTaken: false,
        crawledAt: new Date().toISOString(),
        error: null,
      };

      try {
        // Fetch page content server-side (AgentCore Browser has no JS eval API).
        const extracted = await fetchPageContent(job.url);
        page.title = extracted.title;
        page.contentLength = extracted.text.length;
        page.textSnippet = extracted.text.slice(0, 500);
        page.linksFound = extracted.links;

        // Navigate the browser session to the URL for the screenshot.
        await agentcore.navigateBrowser(crawl.sessionId, job.url);

        const shot = await agentcore.screenshotBrowser(crawl.sessionId);  // navigateBrowser already settled for 3s
        if (shot) page.screenshotTaken = true;

        if (bucket && extracted.text) {
          const key = `${prefix}/${String(crawl.pages.length).padStart(3, '0')}-${slugify(job.url)}.md`;
          const body = `# ${extracted.title || job.url}\n\nSource: ${job.url}\nCrawled: ${page.crawledAt}\nCrawl: ${crawl.id}\n\n${extracted.text}\n`;
          try {
            await s3.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: body,
              ContentType: 'text/markdown',
              Metadata: {
                'source-url': job.url.slice(0, 1024),
                'crawl-id': crawl.id,
                'depth': String(job.depth),
              },
            }));
            page.s3Key = key;
          } catch (err) {
            page.error = `s3 upload failed: ${(err as Error).message}`;
          }
        }

        appendJourneyStep(crawl.sessionId, {
          startedAt: page.crawledAt,
          url: job.url,
          pageTitle: extracted.title,
          textSnippet: page.textSnippet,
          imageDataUrl: shot?.imageDataUrl,
        });

        recordCapabilityEvent({
          id: randomUUID(),
          kind: 'browser_navigate',
          startedAt: page.crawledAt,
          durationMs: Date.now() - new Date(page.crawledAt).getTime(),
          sessionId: crawl.sessionId,
          detail: { url: job.url, title: extracted.title, source: 'crawl', crawlId: crawl.id },
          ok: !page.error,
          ...(page.error ? { error: page.error } : {}),
        });

        // Enqueue child links subject to filters.
        const remaining = crawl.maxPages - crawl.pages.length - 1;
        if (remaining > 0) {
          for (const link of extracted.links) {
            if (visited.has(link)) continue;
            if (queue.some((q) => q.url === link)) continue;
            if (crawl.sameOriginOnly && safeOrigin(link) !== startOrigin) continue;
            if (includeRegex && !includeRegex.test(new URL(link).pathname)) continue;
            queue.push({ url: link, depth: job.depth + 1, parent: job.url });
          }
        }
      } catch (err) {
        page.error = (err as Error).message;
      }

      crawl.pages.push(page);
      crawl.queued = queue.length;
      emit(crawl.id, { type: 'page', page, session: crawl });
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
    try { await agentcore.closeBrowserSession(crawl.sessionId); } catch { /* best effort */ }
  }
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

function safeRegex(pattern: string): RegExp | null {
  try { return new RegExp(pattern); } catch { return null; }
}

