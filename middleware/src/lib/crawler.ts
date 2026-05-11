// Doc-discovery crawler. BFS over a starting URL with depth/page caps, using
// the existing AgentCore Browser CDP session for navigation, screenshot, and
// link extraction. Extracted page text is uploaded to the documents S3 bucket
// so the existing KB ingestion pipeline can index it.

import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { agentcore } from '../providers/index.js';
import { appendJourneyStep, recordCapabilityEvent } from './invocations.js';
import { config } from '../config.js';

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

const EXTRACT_JS = `
(() => {
  const root = document.querySelector('main, article, [role=main], #content, .content') || document.body;
  const text = (root.innerText || '').slice(0, 50000);
  const here = location.href;
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map(a => { try { return new URL(a.href, here).href; } catch { return ''; } })
    .filter(h => h && (h.startsWith('http://') || h.startsWith('https://')))
    .filter(h => !h.includes('#'))
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .slice(0, 200);
  return JSON.stringify({ title: document.title || '', text, links });
})()
`.trim();

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
        await agentcore.navigateBrowser(crawl.sessionId, job.url);
        await new Promise((r) => setTimeout(r, 1500));

        const raw = await agentcore.evaluateInBrowser(crawl.sessionId, EXTRACT_JS);
        const extracted = parseExtracted(raw);
        page.title = extracted.title;
        page.contentLength = extracted.text.length;
        page.textSnippet = extracted.text.slice(0, 500);
        page.linksFound = extracted.links;

        const shot = await agentcore.screenshotBrowser(crawl.sessionId);
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

interface Extracted { title: string; text: string; links: string[]; }
function parseExtracted(raw: unknown): Extracted {
  if (typeof raw === 'string') {
    try {
      const obj = JSON.parse(raw) as Partial<Extracted>;
      return {
        title: obj.title ?? '',
        text: obj.text ?? '',
        links: Array.isArray(obj.links) ? obj.links.filter((x) => typeof x === 'string') : [],
      };
    } catch { /* fall through */ }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Partial<Extracted>;
    return {
      title: o.title ?? '',
      text: o.text ?? '',
      links: Array.isArray(o.links) ? o.links.filter((x) => typeof x === 'string') : [],
    };
  }
  return { title: '', text: '', links: [] };
}
