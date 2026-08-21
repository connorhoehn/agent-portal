// Look at a site before crawling it.
//
// Adding a crawl target was an act of faith: a URL, a page cap, and no way to
// know what was there until a full vision crawl had screenshotted every page
// and written three S3 artifacts each. A site that turns out to be mostly
// changelog and marketing cost the same as one that is all reference docs.
//
// The survey walks the site over plain HTTP first — free — falls back to the
// browser only for pages HTTP genuinely cannot see, and asks a model once
// which sections are worth indexing. What you get is a tree you can choose
// from, and the choice becomes the crawl target's scope.

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

type SectionKind =
  | 'documentation' | 'api-reference' | 'blog' | 'changelog'
  | 'marketing' | 'legal' | 'navigation' | 'other';

interface SurveyPage {
  url: string; path: string; title: string; depth: number;
  contentChars: number; outboundLinks: number;
  via: 'http' | 'browser'; status: 'ok' | 'failed'; error?: string;
}
interface SurveySection {
  prefix: string; label: string; pages: number; contentChars: number;
  kind: SectionKind; recommended: boolean; reason: string;
}
interface SurveyNode {
  path: string; segment: string; page: SurveyPage | null;
  pageCount: number; contentChars: number; children: SurveyNode[];
}
interface Survey {
  id: string; startUrl: string; origin: string;
  status: 'running' | 'completed' | 'failed';
  pages: SurveyPage[]; tree: SurveyNode | null; sections: SurveySection[];
  browserRescued: number; browserSkipped: number; robotsExcluded: number;
  classificationProblem?: string;
  startedAt: string; completedAt: string | null; error: string | null;
}

const KIND_TONE: Record<SectionKind, string> = {
  documentation: 'bg-success-bg text-success',
  'api-reference': 'bg-success-bg text-success',
  blog: 'bg-surface-hover text-text-tertiary',
  changelog: 'bg-surface-hover text-text-tertiary',
  marketing: 'bg-warning-bg text-warning',
  legal: 'bg-warning-bg text-warning',
  navigation: 'bg-surface-hover text-text-tertiary',
  other: 'bg-surface-hover text-text-tertiary',
};

function chars(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function SiteSurveyPanel({ onTargetCreated }: { onTargetCreated?: () => void }) {
  // Surveys and target creation POST /api/ingest (ManageIngest); the whole
  // panel is an action surface, so it hides without the capability.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(120);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  // Poll while the walk is in flight. It is a background job on the server so
  // the request returns immediately; without polling the panel would sit on
  // "running" forever.
  const surveyId = survey?.id;
  const surveyStatus = survey?.status;
  useEffect(() => {
    if (!surveyId || surveyStatus !== 'running') return;
    // Keyed on id and status, not the survey object. Depending on the whole
    // object meant every poll replaced it, which tore down and rebuilt the
    // interval on each tick — the cadence drifted and a timer was churned
    // every two seconds for the life of the walk.
    const id = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/ingest/survey/${surveyId}`, { credentials: 'include' });
          if (res.ok) setSurvey(await res.json() as Survey);
        } catch { /* keep the last good state */ }
      })();
    }, 2000);
    return () => clearInterval(id);
  }, [surveyId, surveyStatus]);

  // Pre-select what the model recommended, so the common case is one click.
  useEffect(() => {
    if (survey?.status === 'completed' && selected.size === 0) {
      setSelected(new Set(survey.sections.filter((s) => s.recommended).map((s) => s.prefix)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survey?.status]);

  const run = useCallback(async () => {
    if (!url.trim()) return;
    setStarting(true);
    setSelected(new Set());
    try {
      const res = await fetch('/api/ingest/survey', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUrl: url.trim(), maxPages }),
      });
      const body = await res.json() as Survey & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSurvey(body);
    } catch (err) {
      toastError(null, 'Could not start the survey', (err as Error).message);
    } finally { setStarting(false); }
  }, [url, maxPages]);

  const createTarget = useCallback(async () => {
    if (!survey || selected.size === 0) return;
    setCreating(true);
    const tid = toastPending('Creating crawl target', `${selected.size} sections`);
    try {
      const res = await fetch(`/api/ingest/survey/${survey.id}/target`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [...selected] }),
      });
      const body = await res.json() as { target?: { label: string }; pagesInScope?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Crawl target created',
        `${body.target?.label} — scoped to ${body.pagesInScope} pages.`);
      onTargetCreated?.();
    } catch (err) {
      toastError(tid, 'Could not create the target', (err as Error).message);
    } finally { setCreating(false); }
  }, [survey, selected, onTargetCreated]);

  const toggle = (prefix: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
    return next;
  });

  const ok = survey?.pages.filter((p) => p.status === 'ok').length ?? 0;
  const failed = (survey?.pages.length ?? 0) - ok;
  const selectedPages = (survey?.sections ?? [])
    .filter((s) => selected.has(s.prefix))
    .reduce((n, s) => n + s.pages, 0);

  if (!canManage) return null;

  return (
    <Card padding="none" className="overflow-hidden mb-4">
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">SURVEY A SITE</span>
        <span className="text-[11px] text-text-tertiary">
          see what is there before paying to crawl it
        </span>
      </div>

      <div className="px-3.5 py-3 flex flex-wrap items-end gap-2.5 border-b border-border">
        <label className="flex-1 min-w-[260px]">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
            Start URL
          </span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            placeholder="https://docs.example.com"
            className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary font-mono"
          />
        </label>
        <label>
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
            Look at
          </span>
          <select
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
          >
            <option value={40}>40 pages</option>
            <option value={120}>120 pages</option>
            <option value={250}>250 pages</option>
          </select>
        </label>
        <button
          disabled={starting || !url.trim() || survey?.status === 'running'}
          onClick={() => void run()}
          className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
        >
          {survey?.status === 'running' ? 'surveying…' : starting ? 'starting…' : 'Survey'}
        </button>
        <div className="w-full text-[11px] text-text-tertiary leading-snug">
          Reads pages over plain HTTP — no screenshots, no S3 writes, nothing ingested. Pages that only
          render in JavaScript fall back to the browser, which is the one thing that can see them.
        </div>
      </div>

      {survey?.status === 'failed' && (
        <div className="px-3.5 py-3 text-[12px] text-danger">{survey.error}</div>
      )}

      {survey && survey.status !== 'failed' && (
        <>
          <div className="px-3.5 py-2.5 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <span className="text-text-secondary">
              <strong className="text-text-primary">{ok}</strong> pages read
            </span>
            {failed > 0 && <span className="text-text-tertiary">{failed} unreadable</span>}
            {survey.browserRescued > 0 && (
              <span className="text-primary" title="Pages plain HTTP saw as empty; the browser rendered them">
                {survey.browserRescued} recovered by the browser
              </span>
            )}
            {survey.browserSkipped > 0 && (
              <span className="text-warning" title="The browser fallback is capped so a survey cannot quietly become a full vision crawl">
                {survey.browserSkipped} more needed the browser — crawl this one in browser mode
              </span>
            )}
            {survey.robotsExcluded > 0 && (
              <span className="text-text-tertiary" title="robots.txt asks crawlers not to fetch these">
                {survey.robotsExcluded} excluded by robots.txt
              </span>
            )}
            <span className="text-text-tertiary">{survey.sections.length} sections</span>
            {survey.status === 'running' && (
              <span className="text-warning animate-pulse">walking…</span>
            )}
          </div>

          {survey.classificationProblem && (
            <div className="px-3.5 py-2 text-[11px] text-warning border-b border-border">
              {survey.classificationProblem}
            </div>
          )}

          {survey.sections.length > 0 && (
            <div className="border-b border-border">
              {survey.sections.map((s) => (
                <label
                  key={s.prefix}
                  className="px-3.5 py-2.5 border-b border-border last:border-b-0 flex items-start gap-3 cursor-pointer hover:bg-surface-hover/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.prefix)}
                    onChange={() => toggle(s.prefix)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[12px] font-mono font-semibold text-text-primary">{s.label}</span>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${KIND_TONE[s.kind]}`}>
                        {s.kind}
                      </span>
                      {s.recommended && (
                        <span className="text-[10px] font-semibold text-success">recommended</span>
                      )}
                    </div>
                    <div className="text-[11px] text-text-secondary mt-0.5 leading-snug">{s.reason}</div>
                  </div>
                  <div className="text-[11px] text-text-tertiary text-right shrink-0 tabular-nums">
                    <div>{s.pages} {s.pages === 1 ? 'page' : 'pages'}</div>
                    <div>{chars(s.contentChars)} chars</div>
                  </div>
                </label>
              ))}
            </div>
          )}

          {survey.tree && (
            <details className="border-b border-border">
              <summary className="px-3.5 py-2 text-[11px] text-text-secondary cursor-pointer select-none">
                Structure ({survey.tree.pageCount} pages)
              </summary>
              <div className="px-3.5 pb-3 max-h-[320px] overflow-auto">
                <TreeNode node={survey.tree} depth={0} selected={selected} defaultOpen />
              </div>
            </details>
          )}

          {survey.status === 'completed' && (
            <div className="px-3.5 py-3 flex items-center gap-3 flex-wrap">
              <button
                disabled={creating || selected.size === 0}
                onClick={() => void createTarget()}
                className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
              >
                {creating ? 'creating…' : 'Create crawl target from selection'}
              </button>
              <span className="text-[11px] text-text-tertiary">
                {selected.size === 0
                  ? 'Nothing selected.'
                  : `${selected.size} ${selected.size === 1 ? 'section' : 'sections'} · about ${selectedPages} pages will be crawled and indexed.`}
              </span>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * One level of the path tree.
 *
 * Branches under a selected section are tinted, so the tree and the checkboxes
 * above it are visibly the same decision rather than two unrelated lists.
 */
function TreeNode({ node, depth, selected, defaultOpen = false }: {
  node: SurveyNode; depth: number; selected: Set<string>; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || depth < 1);
  const inScope = [...selected].some((p) => node.path === p || node.path.startsWith(`${p}/`));
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-0.5 text-[11px] ${inScope ? 'text-text-primary' : 'text-text-tertiary'}`}
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="w-3 shrink-0 bg-transparent border-none cursor-pointer text-text-tertiary p-0 leading-none"
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className={`font-mono truncate ${inScope ? 'font-semibold' : ''}`}>
          {node.segment}
        </span>
        {node.page && (
          <span className="text-text-tertiary truncate flex-1 min-w-0" title={node.page.title}>
            {node.page.title}
          </span>
        )}
        {node.page?.via === 'browser' && (
          <span className="text-[10px] text-primary shrink-0" title="Only visible through the browser">
            browser
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-text-tertiary">
          {hasChildren ? `${node.pageCount} · ` : ''}{chars(node.contentChars)}
        </span>
      </div>
      {open && node.children.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} />
      ))}
    </div>
  );
}
