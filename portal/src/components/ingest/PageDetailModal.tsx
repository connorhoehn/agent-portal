import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  CodeBlock,
  EmptyState,
  EntityCell,
  Inline,
  LoadingState,
  MetaLine,
  Modal,
  SectionLabel,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  Tabs,
} from '@connorhoehnslalom/ui-components/shared';
import { PAGE_STATUS_TONE, formatBytes, formatDuration } from './types';
import type { CrawlPage } from './types';
import { Markdown } from '../Markdown';

type Tab = 'screenshot' | 'markdown' | 'analysis' | 'links';

interface PageDetailResponse {
  page: CrawlPage;
  analysis: Record<string, unknown> | null;
}

export function PageDetailModal({
  crawlId,
  pageIdx,
  fallback,
  onClose,
}: {
  crawlId: string;
  pageIdx: number;
  fallback: CrawlPage;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('screenshot');
  const [detail, setDetail] = useState<PageDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/ingest/crawl/${encodeURIComponent(crawlId)}/page/${pageIdx}`)
      .then(r => r.ok ? r.json() as Promise<PageDetailResponse> : Promise.reject(r.statusText))
      .then(body => { if (!cancelled) setDetail(body); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [crawlId, pageIdx]);

  const page = detail?.page ?? fallback;

  const TABS = [
    { id: 'screenshot', label: 'Screenshot' },
    { id: 'markdown',   label: 'Markdown' },
    { id: 'analysis',   label: 'Vision Analysis' },
    {
      id: 'links',
      label: 'Links Discovered',
      // The count rode in as a dimmed <span> inside the button's own label;
      // TabItem has a badge slot for exactly this.
      ...(page.discoveredLinks.length > 0 ? { badge: page.discoveredLinks.length } : {}),
    },
  ];

  return (
    <Modal open={true} onClose={onClose} maxWidth={960}>
      <Card padding="md" className="w-[min(960px,92vw)] max-h-[88vh] flex flex-col">
        <Inline align="start" justify="between" gap="md" className="mb-3">
          <Stack gap="none" className="min-w-0 flex-1">
            <Inline gap="sm" align="center" className="mb-1 min-w-0">
              <EntityCell label={page.title || page.url} labelClassName="text-sm" className="min-w-0" />
              <Chip tone={PAGE_STATUS_TONE[page.status]} size="xs">{page.status}</Chip>
            </Inline>
            <MetaLine
              size="xs"
              className="font-mono truncate"
              items={[<span key="u" title={page.url}>{page.url}</span>]}
            />
          </Stack>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </Inline>

        <Tabs
          idPrefix="page-detail"
          aria-label="Page detail"
          variant="underline"
          size="sm"
          items={TABS}
          value={tab}
          onValueChange={(id) => setTab(id as typeof tab)}
          className="mb-3"
        />

        <Stack gap="none" className="flex-1 overflow-auto min-h-0">
          {tab === 'screenshot' && (
            <ScreenshotTab crawlId={crawlId} pageIdx={pageIdx} hasScreenshot={!!page.s3ScreenshotKey} />
          )}
          {tab === 'markdown' && <MarkdownTab text={page.mainText} />}
          {tab === 'analysis' && <AnalysisTab detail={detail} loading={loading} page={page} />}
          {tab === 'links' && <LinksTab links={page.discoveredLinks} />}
        </Stack>

        <Stack gap="xs" className="border-t border-border mt-3 pt-2.5">
          <MetaLine
            size="xs"
            separator="   "
            items={[
              `screenshot: ${formatBytes(page.screenshotBytes)}`,
              `content: ${formatBytes(page.contentLength)}`,
              `vision: ${page.visionTokensIn}→${page.visionTokensOut} tok · ${formatDuration(page.visionLatencyMs)}`,
              page.kbIngestedAt ? `KB ingested ${new Date(page.kbIngestedAt).toLocaleString()}` : null,
            ]}
          />
          <S3KeysList page={page} />
        </Stack>
      </Card>
    </Modal>
  );
}


function ScreenshotTab({
  crawlId,
  pageIdx,
  hasScreenshot,
}: {
  crawlId: string;
  pageIdx: number;
  hasScreenshot: boolean;
}) {
  const [errored, setErrored] = useState(false);

  if (!hasScreenshot || errored) {
    return (
      <EmptyState
        title={errored ? 'Failed to load screenshot.' : 'Screenshot has not been uploaded yet.'}
      />
    );
  }

  return (
    <img
      src={`/api/ingest/crawl/${encodeURIComponent(crawlId)}/page/${pageIdx}/screenshot`}
      alt="Page screenshot"
      onError={() => setErrored(true)}
      className="block w-full h-auto rounded border border-border"
    />
  );
}

function MarkdownTab({ text }: { text: string }) {
  if (!text) {
    return (
      <EmptyState title="No extracted text for this page." />
    );
  }
  return (
    <Card padding="sm"><Markdown size={13}>{text}</Markdown></Card>
  );
}

function AnalysisTab({
  detail,
  loading,
  page,
}: {
  detail: PageDetailResponse | null;
  loading: boolean;
  page: CrawlPage;
}) {
  if (loading) {
    return (
      <LoadingState label="Loading analysis…" />
    );
  }
  const analysis = detail?.analysis ?? {
    title: page.title,
    summary: page.summary,
    discoveredLinks: page.discoveredLinks,
  };
  return (
    <CodeBlock language="json" copyButton={false} code={JSON.stringify(analysis, null, 2)} />
  );
}

function LinksTab({ links }: { links: CrawlPage['discoveredLinks'] }) {
  if (links.length === 0) {
    return (
      <EmptyState title="No links discovered on this page." />
    );
  }
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableTh>Label</TableTh>
          <TableTh>Target</TableTh>
          <TableTh>Type</TableTh>
          <TableTh className="text-right">Coords</TableTh>
        </TableRow>
      </TableHead>
      <TableBody>
        {links.map((l, i) => (
          <TableRow key={i}>
            <TableTd className="text-[12px]">{l.label || <em className="text-text-tertiary">(unlabeled)</em>}</TableTd>
            <TableTd
              className="text-[11px] font-mono text-text-secondary max-w-[360px] overflow-hidden truncate whitespace-nowrap"
              title={l.targetUrl ?? ''}
            >
              {l.targetUrl ?? '—'}
            </TableTd>
            <TableTd>
              {l.isSpaLink
                ? <Chip tone="warning" size="xs">SPA</Chip>
                : <Chip tone="neutral" size="xs">href</Chip>}
            </TableTd>
            <TableTd
              className="text-right text-[11px] font-mono text-text-tertiary"
            >
              {l.clickX != null && l.clickY != null ? `(${l.clickX}, ${l.clickY})` : '—'}
            </TableTd>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function S3KeysList({ page }: { page: CrawlPage }) {
  const entries: Array<{ label: string; key: string | null }> = [
    { label: 'screenshot', key: page.s3ScreenshotKey },
    { label: 'markdown',   key: page.s3MarkdownKey },
    { label: 'analysis',   key: page.s3AnalysisKey },
  ];
  return (
    <Stack gap="none" className="flex flex-col gap-0.5">
      {entries.map(e => (
        <Inline gap="none" key={e.label} className="flex items-center gap-2 text-[10px]">
          <SectionLabel className="w-20 shrink-0">
            {e.label}
          </SectionLabel>
          {e.key ? (
            <>
              <Inline as="code" gap="none"
                className="font-mono text-text-secondary"
                title={e.key}
              >
                {e.key}
              </Inline>
              <CopyButton text={e.key} />
            </>
          ) : (
            <Inline as="span" gap="none" className="text-text-tertiary">—</Inline>
          )}
        </Inline>
      ))}
    </Stack>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore — clipboard might be unavailable
    }
  }
  return (
    <Button variant="secondary" size="sm" onClick={copy} className="px-1.5 py-px text-[10px]">
      {copied ? 'copied' : 'copy'}
    </Button>
  );
}
