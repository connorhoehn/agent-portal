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
import {
  Button, Card, Checkbox, Chip, EntityCell, FormField, Inline, InlineAlert,
  Input, MetaLine, SectionLabel, Select, Stack, Toolbar,
} from '@connorhoehnslalom/ui-components/shared';
import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
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

// What a section's kind is worth indexing, as a Chip tone rather than a pair of
// background/foreground classes. Same three buckets as before: reference
// material reads success, marketing and legal read warning, the rest neutral.
const KIND_TONE: Record<SectionKind, ChipTone> = {
  documentation: 'success',
  'api-reference': 'success',
  blog: 'neutral',
  changelog: 'neutral',
  marketing: 'warning',
  legal: 'warning',
  navigation: 'neutral',
  other: 'neutral',
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
      <Toolbar bordered size="sm">
        <SectionLabel>Survey a site</SectionLabel>
        <MetaLine size="xs" items={['see what is there before paying to crawl it']} />
      </Toolbar>

      <Stack gap="sm" className="px-3.5 py-3 border-b border-border">
        {/* `labelId` is dropped from every wiring bag: FormField hands it to the
            consumer but it is not a DOM prop, so spreading it makes React warn. */}
        <Inline gap="sm" align="end" wrap>
          <FormField label="Start URL" className="flex-1 min-w-[260px]">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                size="sm"
                mono
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
                placeholder="https://docs.example.com"
              />
            )}
          </FormField>

          <FormField label="Look at">
            {({ labelId: _l, ...w }) => (
              <Select
                {...w}
                size="sm"
                value={String(maxPages)}
                onChange={(e) => setMaxPages(Number(e.target.value))}
                options={[
                  { value: '40', label: '40 pages' },
                  { value: '120', label: '120 pages' },
                  { value: '250', label: '250 pages' },
                ]}
              />
            )}
          </FormField>

          <Button
            variant="primary"
            size="sm"
            disabled={starting || !url.trim() || survey?.status === 'running'}
            onClick={() => void run()}
          >
            {survey?.status === 'running' ? 'surveying…' : starting ? 'starting…' : 'Survey'}
          </Button>
        </Inline>

        <MetaLine
          size="xs"
          items={['Reads pages over plain HTTP — no screenshots, no S3 writes, nothing ingested. Pages '
            + 'that only render in JavaScript fall back to the browser, which is the one thing that can '
            + 'see them.']}
        />
      </Stack>

      {survey?.status === 'failed' && (
        <Stack gap="none" className="px-3.5 py-3">
          <InlineAlert tone="error">{survey.error}</InlineAlert>
        </Stack>
      )}

      {survey && survey.status !== 'failed' && (
        <>
          {/* Each stat carries its own meaning, so these are toned chips rather
              than one MetaLine — MetaLine takes a single tone for every item,
              and "recovered by the browser" and "needed the browser" are not
              the same news. */}
          <Inline gap="xs" wrap className="px-3.5 py-2.5 border-b border-border">
            <Chip tone="neutral" size="xs">{ok} pages read</Chip>
            {failed > 0 && <Chip tone="neutral" size="xs">{failed} unreadable</Chip>}
            {survey.browserRescued > 0 && (
              <Chip tone="info" size="xs" title="Pages plain HTTP saw as empty; the browser rendered them">
                {survey.browserRescued} recovered by the browser
              </Chip>
            )}
            {survey.browserSkipped > 0 && (
              <Chip
                tone="warning"
                size="xs"
                title="The browser fallback is capped so a survey cannot quietly become a full vision crawl"
              >
                {survey.browserSkipped} more needed the browser — crawl this one in browser mode
              </Chip>
            )}
            {survey.robotsExcluded > 0 && (
              <Chip tone="neutral" size="xs" title="robots.txt asks crawlers not to fetch these">
                {survey.robotsExcluded} excluded by robots.txt
              </Chip>
            )}
            <Chip tone="neutral" size="xs">{survey.sections.length} sections</Chip>
            {survey.status === 'running' && (
              <Chip tone="warning" size="xs" dot="pulse">walking…</Chip>
            )}
          </Inline>

          {survey.classificationProblem && (
            <Stack gap="none" className="px-3.5 py-2 border-b border-border">
              <InlineAlert tone="warning">{survey.classificationProblem}</InlineAlert>
            </Stack>
          )}

          {survey.sections.length > 0 && (
            <Stack gap="none" className="border-b border-border">
              {survey.sections.map((s) => (
                // `as="label"` keeps the whole row a click target for its
                // checkbox — the native behaviour the raw <label> had — without
                // a raw styled element.
                <Inline
                  key={s.prefix}
                  as="label"
                  gap="sm"
                  align="start"
                  wrap={false}
                  className="px-3.5 py-2.5 border-b border-border last:border-b-0 cursor-pointer hover:bg-surface-hover/50"
                >
                  <Checkbox
                    checked={selected.has(s.prefix)}
                    onChange={() => toggle(s.prefix)}
                    className="mt-0.5"
                  />
                  <Stack gap="none" className="flex-1 min-w-0">
                    <Inline gap="xs" wrap>
                      <EntityCell mono label={s.label} />
                      <Chip tone={KIND_TONE[s.kind]} size="xs">{s.kind}</Chip>
                      {s.recommended && <Chip tone="success" size="xs">recommended</Chip>}
                    </Inline>
                    <MetaLine size="xs" tone="secondary" items={[s.reason]} />
                  </Stack>
                  <Stack gap="none" align="end" className="shrink-0 tabular-nums">
                    <MetaLine size="xs" items={[`${s.pages} ${s.pages === 1 ? 'page' : 'pages'}`]} />
                    <MetaLine size="xs" items={[`${chars(s.contentChars)} chars`]} />
                  </Stack>
                </Inline>
              ))}
            </Stack>
          )}

          {survey.tree && (
            // <details> stays: the library has no disclosure primitive, and the
            // native element already does the keyboard and ARIA work a
            // hand-rolled button+state pair would have to re-earn. Neither tag
            // carries a className, so nothing here is a styled raw element.
            <details className="border-b border-border">
              <summary>
                <MetaLine
                  size="xs"
                  tone="secondary"
                  className="inline-flex px-3.5 py-2 cursor-pointer select-none"
                  items={[`Structure (${survey.tree.pageCount} pages)`]}
                />
              </summary>
              <Stack gap="none" className="px-3.5 pb-3 max-h-[320px] overflow-auto">
                <TreeNode node={survey.tree} depth={0} selected={selected} defaultOpen />
              </Stack>
            </details>
          )}

          {survey.status === 'completed' && (
            <Inline gap="sm" wrap className="px-3.5 py-3">
              <Button
                variant="primary"
                size="sm"
                disabled={creating || selected.size === 0}
                onClick={() => void createTarget()}
              >
                {creating ? 'creating…' : 'Create crawl target from selection'}
              </Button>
              <MetaLine
                size="xs"
                items={[selected.size === 0
                  ? 'Nothing selected.'
                  : `${selected.size} ${selected.size === 1 ? 'section' : 'sections'} · about `
                    + `${selectedPages} pages will be crawled and indexed.`]}
              />
            </Inline>
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
    <Stack gap="none">
      <Inline
        gap="xs"
        wrap={false}
        className={`py-0.5 text-[11px] ${inScope ? 'text-text-primary' : 'text-text-tertiary'}`}
        // Runtime-derived: Tailwind cannot build a class from `depth * 14`, and
        // enumerating a padding class per depth would cap the tree's depth.
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="w-3 shrink-0 p-0 leading-none"
          >
            {open ? '▾' : '▸'}
          </Button>
        ) : (
          <Inline gap="none" className="w-3 shrink-0" aria-hidden />
        )}
        <EntityCell mono label={node.segment} labelClassName={inScope ? 'font-semibold' : undefined} />
        {node.page && (
          <MetaLine
            size="xs"
            className="truncate flex-1 min-w-0"
            items={[node.page.title]}
          />
        )}
        {node.page?.via === 'browser' && (
          <Chip tone="info" size="xs" className="shrink-0" title="Only visible through the browser">
            browser
          </Chip>
        )}
        {/* The "N unreadable" strip above says how many pages failed but not
            why — a page that failed because the browser capability is
            misconfigured (see the BROWSER_ID drift gotcha) looked identical
            to one that is genuinely bot-blocked. The reason the survey
            already computed is now on the node it happened to. */}
        {node.page?.status === 'failed' && (
          <Chip tone="danger" size="xs" className="shrink-0" title={node.page.error || 'Could not read this page'}>
            unreadable
          </Chip>
        )}
        <MetaLine
          size="xs"
          className="ml-auto shrink-0 tabular-nums"
          items={[`${hasChildren ? `${node.pageCount} · ` : ''}${chars(node.contentChars)}`]}
        />
      </Inline>
      {open && node.children.map((c) => (
        <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} />
      ))}
    </Stack>
  );
}
