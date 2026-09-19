import { requirePublicBrowser } from './public-browser.js';
import { publicWebFetch, assertPublicWebTarget } from './public-web-fetch.js';
// Site survey — look before you crawl.
//
// Adding a crawl target was blind. You typed a URL and a page limit, and found
// out what the site actually contained only after a full vision crawl had
// screenshotted every page, called Nova on each one, and written three S3
// artifacts per page. If the site turned out to be 80% marketing and changelog
// noise, you paid for all of it before you could tell.
//
// A survey is the cheap reconnaissance pass that should come first:
//
//   1. Walk the site over plain HTTP, collecting URLs, titles, link structure
//      and content volume. Free, and fast enough to cover a few hundred pages.
//   2. Where plain HTTP sees nothing — a JavaScript shell that ships an empty
//      <body> — fall back to the AgentCore Browser and read the rendered page
//      through vision. This is the one place the browser capability is load
//      bearing rather than decorative: it is the only way to see those pages at
//      all, and it runs on the handful that need it instead of on all of them.
//   3. Ask a model once, over the whole inventory, which sections are worth
//      indexing. Judgment is needed exactly once — about the shape of the site
//      — not once per page.
//
// Nothing here writes to S3, enqueues ingestion, or costs per page. The output
// is a tree you can look at and choose from.

import { randomUUID } from 'node:crypto';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { agentcore } from '../providers/index.js';
import { extractFromScreenshot } from './vision-extractor.js';
import { config } from '../config.js';
import { reached, unreachable, type Upstream } from './upstream.js';

const MODEL_ID = process.env['SURVEY_MODEL_ID'] ?? 'amazon.nova-pro-v1:0';

let _bedrock: BedrockRuntimeClient | null = null;
const bedrock = (): BedrockRuntimeClient =>
  (_bedrock ??= new BedrockRuntimeClient({ region: config.region }));

// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionKind =
  | 'documentation' | 'api-reference' | 'blog' | 'changelog'
  | 'marketing' | 'legal' | 'navigation' | 'other';

export interface SurveyPage {
  url: string;
  /** Path relative to the site root, always leading-slashed. */
  path: string;
  title: string;
  depth: number;
  /** Characters of extracted text — the honest proxy for "is there content here". */
  contentChars: number;
  outboundLinks: number;
  /** How this page was read. `browser` means plain HTTP could not see it. */
  via: 'http' | 'browser';
  status: 'ok' | 'failed';
  error?: string;
}

export interface SurveySection {
  /** Path prefix that defines the section, e.g. "/docs". */
  prefix: string;
  label: string;
  pages: number;
  contentChars: number;
  kind: SectionKind;
  /** Whether a model thought this belongs in a knowledge base, and why. */
  recommended: boolean;
  reason: string;
}

export interface SurveyNode {
  /** Full path of this node, e.g. "/docs/api". */
  path: string;
  /** Just this level's segment, for rendering. */
  segment: string;
  /** A page exists at exactly this path. */
  page: SurveyPage | null;
  /** Pages at or below this node. */
  pageCount: number;
  contentChars: number;
  children: SurveyNode[];
}

export interface Survey {
  id: string;
  startUrl: string;
  origin: string;
  status: 'running' | 'completed' | 'failed';
  pages: SurveyPage[];
  tree: SurveyNode | null;
  sections: SurveySection[];
  /** Pages plain HTTP could not read, that the browser recovered. */
  browserRescued: number;
  /** Pages that needed the browser after the rescue budget ran out. */
  browserSkipped: number;
  /** Browser fallback could not establish a public-only session. */
  browserProblem?: string;
  /** Links skipped because robots.txt asks crawlers not to fetch them. */
  robotsExcluded: number;
  /** Set when classification could not run; the tree is still valid. */
  classificationProblem?: string;
  /**
   * Set when robots.txt could not be READ — not when it was read and imposed
   * nothing. The crawl still ran, unrestricted, so this is the sentence that
   * separates "this site asks nothing of crawlers" from "we fetched it without
   * knowing what it asks."
   */
  robotsProblem?: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

/**
 * Completed surveys, newest last.
 *
 * Each holds up to a few hundred pages of metadata and nothing evicted them,
 * so a long-lived process grew by one survey's worth every time anyone looked
 * at a site. Surveys are disposable — the durable output is the crawl target
 * you create from one — so keeping the last handful is enough.
 */
const MAX_RETAINED_SURVEYS = 10;
const _surveys = new Map<string, Survey>();

function evictOldSurveys(): void {
  while (_surveys.size > MAX_RETAINED_SURVEYS) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    const oldest = _surveys.keys().next().value;
    if (oldest === undefined) break;
    _surveys.delete(oldest);
  }
}

export function getSurvey(id: string): Survey | null {
  return _surveys.get(id) ?? null;
}

export function listSurveys(limit = 10): Survey[] {
  return [...  _surveys.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

/**
 * How many pages the browser fallback may rescue in one survey.
 *
 * The whole argument for the fallback is that it runs on the handful of pages
 * plain HTTP cannot see. Nothing enforced that: a fully client-rendered site
 * would have taken the fallback on every page, which is a vision call each —
 * exactly the per-page cost the survey exists to avoid, incurred silently
 * because the fallback fails soft.
 *
 * Past this many, the survey stops rescuing and says so. A site where more
 * than a dozen pages need a real browser is not a site to survey cheaply; it
 * is a site to crawl in browser mode deliberately.
 */
const MAX_BROWSER_RESCUES = 12;

/** Assets and endpoints that are never worth surveying. */
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|eot|zip|tar|gz|pdf|mp4|webm|xml|rss|atom)(\?|$)/i;

function normalizeUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    // Fragments address a position on a page already counted; query strings are
    // usually the same page filtered. Both inflate the map without adding
    // anything a crawl would ingest separately.
    u.hash = '';
    u.search = '';
    let href = u.href;
    if (href.endsWith('/') && u.pathname !== '/') href = href.slice(0, -1);
    return href;
  } catch {
    return null;
  }
}

interface RawPage { title: string; text: string; links: string[] }

/**
 * Paths the site asks crawlers to leave alone.
 *
 * This fetches arbitrary third-party sites on someone's say-so, so honouring
 * robots.txt is the minimum. Deliberately a small subset of the standard: the
 * `User-agent: *` group's Disallow prefixes. Anything unparseable is treated
 * as "no restrictions" rather than blocking the survey outright — a site with
 * an odd robots.txt should still be surveyable.
 *
 * THE EMPTY LIST MEANT THREE THINGS. "This site restricts nothing", "robots.txt
 * is 404 so there are no rules", and "the fetch timed out / the server
 * answered 503, so we have no idea what the rules are" all came back as `[]`,
 * and the crawler then fetched everything with equal confidence. Of the three
 * that is the one worth telling apart, because it is the only one where the
 * survey did something it might not have been allowed to do — and it is
 * invisible: robots.txt failing does not fail the crawl, so nothing else in
 * the run report would ever mention it.
 *
 * A 404 is still `reached([])`. That is not a failure; it is the standard's
 * own way of saying "no restrictions", and marking it degraded would put a
 * warning on the majority of ordinary sites. Any other non-2xx, and any
 * thrown fetch, is degraded — same permissive BEHAVIOUR as before (the survey
 * proceeds), now with the fact recorded.
 */
export async function disallowedPrefixes(origin: string): Promise<Upstream<string[]>> {
  try {
    const res = await publicWebFetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': 'OrgIQ-Survey/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return reached([]);
    if (!res.ok) {
      return unreachable([] as string[], new Error(`HTTP ${res.status}`), `${origin}/robots.txt`);
    }
    const out: string[] = [];
    let inStar = false;
    for (const raw of (await res.text()).split('\n')) {
      const line = raw.split('#')[0]?.trim() ?? '';
      if (!line) continue;
      const [keyRaw, ...rest] = line.split(':');
      const key = (keyRaw ?? '').trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'user-agent') {
        inStar = value === '*';
      } else if (key === 'disallow' && inStar && value) {
        out.push(value);
      }
    }
    return reached(out);
  } catch (err) {
    return unreachable([] as string[], err, `${origin}/robots.txt`);
  }
}

function isDisallowed(url: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  try {
    const path = new URL(url).pathname;
    return prefixes.some((p) => path.startsWith(p));
  } catch {
    return false;
  }
}

async function readOverHttp(url: string): Promise<RawPage | { error: string }> {
  try {
    const res = await publicWebFetch(url, {
      headers: { 'User-Agent': 'OrgIQ-Survey/1.0 (+site reconnaissance)' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('html')) return { error: `not HTML (${ctype.split(';')[0]})` };

    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const links: string[] = [];
    const seen = new Set<string>();
    const re = /href=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && links.length < 300) {
      const abs = normalizeUrl(m[1] ?? '', url);
      if (!abs || seen.has(abs) || SKIP_EXT.test(abs)) continue;
      seen.add(abs);
      links.push(abs);
    }
    return { title, text, links };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * A page whose HTML carries no content and no links is a JavaScript shell —
 * plain HTTP genuinely cannot see it, and only a real browser can.
 */
function looksLikeJsShell(p: RawPage): boolean {
  return p.text.length < 240 && p.links.length <= 2;
}

/**
 * Read a page the way a person would see it.
 *
 * AgentCore Browser exposes no DOM — the action API is mouse, keyboard and
 * screenshot only — so "reading" means screenshotting and letting a vision
 * model report what is on the page. Expensive, which is exactly why this is
 * reserved for pages HTTP could not read.
 */
async function readOverBrowser(sessionId: string, url: string): Promise<RawPage | { error: string }> {
  try {
    await assertPublicWebTarget(url);
    await agentcore.navigateBrowser(sessionId, url);
    const shot = await agentcore.screenshotBrowser(sessionId);
    if (!shot?.imageDataUrl) return { error: 'no screenshot' };

    const comma = shot.imageDataUrl.indexOf(',');
    const png = Buffer.from(
      comma >= 0 ? shot.imageDataUrl.slice(comma + 1) : shot.imageDataUrl, 'base64',
    );
    const extracted = await extractFromScreenshot(png, url);
    const links = (extracted.discoveredLinks ?? [])
      .map((l) => (l.targetUrl ? normalizeUrl(l.targetUrl, url) : null))
      .filter((u): u is string => Boolean(u) && !SKIP_EXT.test(u!));
    return {
      title: extracted.title ?? '',
      text: `${extracted.summary ?? ''} ${extracted.mainText ?? ''}`.trim(),
      links,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ─── Classification ───────────────────────────────────────────────────────────

const KIND_BY_HINT: Array<[RegExp, SectionKind]> = [
  [/^\/(docs?|documentation|guide|guides|manual|handbook|learn)/i, 'documentation'],
  [/^\/(api|reference|sdk)/i, 'api-reference'],
  [/^\/(blog|news|posts?|articles?)/i, 'blog'],
  [/^\/(changelog|releases?|whats-new)/i, 'changelog'],
  [/^\/(legal|terms|privacy|cookie|licen[cs]e)/i, 'legal'],
  [/^\/(pricing|about|contact|careers|jobs|customers|partners)/i, 'marketing'],
];

/** Cheap, deterministic first guess, used when the model is unavailable. */
function guessKind(prefix: string): SectionKind {
  for (const [re, kind] of KIND_BY_HINT) if (re.test(prefix)) return kind;
  return 'other';
}

const DEFAULT_RECOMMENDED = new Set<SectionKind>(['documentation', 'api-reference']);

/**
 * Ask a model which sections belong in a knowledge base.
 *
 * One call for the whole site. The inventory — path, page count, content
 * volume, a few sample titles — is enough to judge what a section is, and it
 * costs a fraction of what reading every page would.
 */
async function classifySections(
  origin: string,
  sections: SurveySection[],
  samples: Map<string, string[]>,
): Promise<{ sections: SurveySection[]; problem?: string }> {
  if (sections.length === 0) return { sections };

  const inventory = sections.map((s) => ({
    prefix: s.prefix,
    pages: s.pages,
    approxWords: Math.round(s.contentChars / 6),
    sampleTitles: (samples.get(s.prefix) ?? []).slice(0, 5),
  }));

  const prompt = [
    `You are triaging a website for ingestion into a company knowledge base that agents will cite when answering questions.`,
    ``,
    `Site: ${origin}`,
    ``,
    `Sections found:`,
    JSON.stringify(inventory, null, 2),
    ``,
    `For each section decide:`,
    `- kind: one of documentation, api-reference, blog, changelog, marketing, legal, navigation, other`,
    `- recommended: true only if indexing it would help answer real questions. Reference and explanatory material usually qualifies. Marketing pages, legal boilerplate, and pure navigation indexes usually do not. Time-stamped announcements are rarely worth it unless the site is mostly announcements.`,
    `- reason: one short sentence, concrete, about this section specifically.`,
    ``,
    `Reply with JSON only: {"sections":[{"prefix":"...","kind":"...","recommended":true,"reason":"..."}]}`,
  ].join('\n');

  try {
    const out = await bedrock().send(new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 2000, temperature: 0.2 },
    }));
    const text = out.output?.message?.content?.[0]?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as {
      sections?: Array<{ prefix?: string; kind?: string; recommended?: boolean; reason?: string }>;
    };
    const byPrefix = new Map(
      (parsed.sections ?? []).filter((s) => s.prefix).map((s) => [s.prefix as string, s]),
    );

    return {
      sections: sections.map((s) => {
        const hit = byPrefix.get(s.prefix);
        if (!hit) return s;
        const kind = (hit.kind ?? s.kind) as SectionKind;
        return {
          ...s,
          kind,
          recommended: typeof hit.recommended === 'boolean' ? hit.recommended : s.recommended,
          reason: hit.reason?.trim() || s.reason,
        };
      }),
    };
  } catch (err) {
    // The tree is still correct and still selectable; only the advice is gone.
    return {
      sections,
      problem: `Section triage unavailable (${(err as Error).message}) — showing structural guesses instead.`,
    };
  }
}

// ─── Tree ─────────────────────────────────────────────────────────────────────

function buildTree(pages: SurveyPage[]): SurveyNode | null {
  if (pages.length === 0) return null;
  const root: SurveyNode = {
    path: '/', segment: '/', page: null, pageCount: 0, contentChars: 0, children: [],
  };

  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    let node = root;
    let acc = '';
    for (const seg of segments) {
      acc += `/${seg}`;
      let child = node.children.find((c) => c.segment === seg);
      if (!child) {
        child = { path: acc, segment: seg, page: null, pageCount: 0, contentChars: 0, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.page = page;
  }

  // Roll counts upward so a collapsed branch still states its weight.
  const roll = (n: SurveyNode): void => {
    n.pageCount = n.page ? 1 : 0;
    n.contentChars = n.page?.contentChars ?? 0;
    for (const c of n.children) {
      roll(c);
      n.pageCount += c.pageCount;
      n.contentChars += c.contentChars;
    }
    n.children.sort((a, b) => b.pageCount - a.pageCount || a.segment.localeCompare(b.segment));
  };
  roll(root);
  return root;
}

function summarizeSections(pages: SurveyPage[]): {
  sections: SurveySection[]; samples: Map<string, string[]>;
} {
  const byPrefix = new Map<string, { pages: number; chars: number; titles: string[] }>();
  for (const p of pages) {
    const first = p.path.split('/').filter(Boolean)[0];
    const prefix = first ? `/${first}` : '/';
    const slot = byPrefix.get(prefix) ?? { pages: 0, chars: 0, titles: [] };
    slot.pages++;
    slot.chars += p.contentChars;
    if (p.title && slot.titles.length < 8) slot.titles.push(p.title);
    byPrefix.set(prefix, slot);
  }

  const samples = new Map<string, string[]>();
  const sections: SurveySection[] = [];
  for (const [prefix, v] of byPrefix) {
    samples.set(prefix, v.titles);
    const kind = guessKind(prefix);
    sections.push({
      prefix,
      label: prefix === '/' ? '(site root)' : prefix,
      pages: v.pages,
      contentChars: v.chars,
      kind,
      recommended: DEFAULT_RECOMMENDED.has(kind),
      reason: 'Classified from the URL path.',
    });
  }
  sections.sort((a, b) => b.pages - a.pages);
  return { sections, samples };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

export interface StartSurveyInput {
  startUrl: string;
  /** Pages to visit. Kept modest — a survey is a sample, not an inventory. */
  maxPages?: number;
  /** Allow the browser fallback for JavaScript-only pages. */
  useBrowserFallback?: boolean;
}

export async function startSurvey(input: StartSurveyInput): Promise<Survey> {
  const start = normalizeUrl(input.startUrl, input.startUrl);
  if (!start) throw new Error(`Not a usable URL: ${input.startUrl}`);
  const origin = new URL(start).origin;

  const survey: Survey = {
    id: randomUUID(),
    startUrl: start,
    origin,
    status: 'running',
    pages: [],
    tree: null,
    sections: [],
    browserRescued: 0,
    browserSkipped: 0,
    robotsExcluded: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  _surveys.set(survey.id, survey);
  evictOldSurveys();

  void runSurvey(survey, {
    maxPages: Math.max(1, Math.min(400, input.maxPages ?? 120)),
    useBrowserFallback: input.useBrowserFallback !== false,
  }).catch((err) => {
    survey.status = 'failed';
    survey.error = (err as Error).message;
    survey.completedAt = new Date().toISOString();
  });

  return survey;
}

async function runSurvey(
  survey: Survey,
  opts: { maxPages: number; useBrowserFallback: boolean },
): Promise<void> {
  const visited = new Set<string>([survey.startUrl]);
  const queue: Array<{ url: string; depth: number }> = [{ url: survey.startUrl, depth: 0 }];

  // Asked once per origin, before anything is fetched. A failure here does not
  // stop the crawl — it is recorded on the survey, so the report says the site
  // was crawled without its rules rather than implying it had none.
  const robots = await disallowedPrefixes(survey.origin);
  const disallowed = robots.items;
  if (robots.degraded) {
    survey.robotsProblem = `Could not read robots.txt (${robots.error}) — crawled without it.`;
    console.warn(`[site-survey] ${survey.robotsProblem}`);
  }

  // Opened lazily: most sites never need it, and a browser session costs money
  // from the moment it exists.
  let browserSessionId: string | null = null;
  const ensureBrowser = async (): Promise<string | null> => {
    if (!opts.useBrowserFallback || survey.browserProblem) return null;
    if (browserSessionId) return browserSessionId;
    try {
      await requirePublicBrowser();
      await assertPublicWebTarget(survey.startUrl);
      const s = await agentcore.createBrowserSession({
        agentName: 'site-survey', url: survey.startUrl,
      });
      browserSessionId = s.sessionId;
      return browserSessionId;
    } catch (err) {
      survey.browserProblem = `Browser fallback unavailable: ${(err as Error).message}`;
      console.warn(`[site-survey] ${survey.browserProblem}`);
      return null;
    }
  };

  try {
    while (queue.length > 0 && survey.pages.length < opts.maxPages) {
      // Breadth first, so a shallow sample describes the whole site rather than
      // one deep branch of it.
      const job = queue.shift();
      if (!job) break;

      let raw = await readOverHttp(job.url);
      let via: SurveyPage['via'] = 'http';

      if (!('error' in raw) && looksLikeJsShell(raw)) {
        if (survey.browserRescued >= MAX_BROWSER_RESCUES) {
          // Counted rather than silently skipped: "this site is mostly
          // JavaScript" is the single most useful thing a survey can tell you
          // about how it should be crawled.
          survey.browserSkipped++;
        } else {
        const sid = await ensureBrowser();
        if (sid) {
          const rendered = await readOverBrowser(sid, job.url);
          if (!('error' in rendered) && rendered.text.length > raw.text.length) {
            raw = rendered;
            via = 'browser';
            survey.browserRescued++;
          }
        }
        }
      }

      const path = new URL(job.url).pathname || '/';
      if ('error' in raw) {
        survey.pages.push({
          url: job.url, path, title: '', depth: job.depth,
          contentChars: 0, outboundLinks: 0, via, status: 'failed', error: raw.error,
        });
        continue;
      }

      survey.pages.push({
        url: job.url,
        path,
        title: raw.title,
        depth: job.depth,
        contentChars: raw.text.length,
        outboundLinks: raw.links.length,
        via,
        status: 'ok',
      });

      for (const link of raw.links) {
        if (visited.has(link)) continue;
        // Same origin only. A survey that wanders off-site stops describing the
        // thing you asked about.
        if (new URL(link).origin !== survey.origin) continue;
        visited.add(link);
        if (isDisallowed(link, disallowed)) { survey.robotsExcluded++; continue; }
        queue.push({ url: link, depth: job.depth + 1 });
      }
    }

    survey.tree = buildTree(survey.pages.filter((p) => p.status === 'ok'));
    const { sections, samples } = summarizeSections(survey.pages.filter((p) => p.status === 'ok'));
    const classified = await classifySections(survey.origin, sections, samples);
    survey.sections = classified.sections;
    if (classified.problem) survey.classificationProblem = classified.problem;
    survey.status = 'completed';
  } finally {
    survey.completedAt = new Date().toISOString();
    if (browserSessionId) {
      try { await agentcore.closeBrowserSession(browserSessionId); } catch { /* best effort */ }
    }
  }
}
