import React, { useEffect, useRef, useState } from 'react';
import { Card, Chip, Modal, Table, TableHead, TableBody, TableRow, TableTh, TableTd } from '@connorhoehnslalom/ui-components/shared';
import { PAGE_STATUS_TONE, formatBytes, formatDuration } from './types';
import type { CrawlPage } from './types';
import { secondaryBtnStyle, smallBtnStyle } from './ui';
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

  return (
    <Modal open={true} onClose={onClose} maxWidth={960}>
      <Card
        padding="md"
        style={{
          width: 'min(960px, 92vw)',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {page.title || page.url}
              </h3>
              <Chip tone={PAGE_STATUS_TONE[page.status]} size="xs">{page.status}</Chip>
            </div>
            <div
              style={{
                fontSize: 11,
                fontFamily: 'monospace',
                color: 'var(--color-text-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={page.url}
            >
              {page.url}
            </div>
          </div>
          <button onClick={onClose} style={secondaryBtnStyle}>Close</button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', marginBottom: 12 }}>
          <TabButton active={tab === 'screenshot'} onClick={() => setTab('screenshot')}>Screenshot</TabButton>
          <TabButton active={tab === 'markdown'}   onClick={() => setTab('markdown')}>Markdown</TabButton>
          <TabButton active={tab === 'analysis'}   onClick={() => setTab('analysis')}>Vision Analysis</TabButton>
          <TabButton active={tab === 'links'}      onClick={() => setTab('links')}>
            Links Discovered {page.discoveredLinks.length > 0 && <span style={{ opacity: 0.6 }}>({page.discoveredLinks.length})</span>}
          </TabButton>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {tab === 'screenshot' && (
            <ScreenshotTab crawlId={crawlId} pageIdx={pageIdx} hasScreenshot={!!page.s3ScreenshotKey} />
          )}
          {tab === 'markdown' && (
            <MarkdownTab text={page.mainText} />
          )}
          {tab === 'analysis' && (
            <AnalysisTab detail={detail} loading={loading} page={page} />
          )}
          {tab === 'links' && (
            <LinksTab links={page.discoveredLinks} />
          )}
        </div>

        {/* Footer: metrics + S3 keys */}
        <div
          style={{
            borderTop: '1px solid var(--color-border)',
            marginTop: 12,
            paddingTop: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 18, fontSize: 11, color: 'var(--color-text-tertiary)', flexWrap: 'wrap' }}>
            <span>screenshot: {formatBytes(page.screenshotBytes)}</span>
            <span>content: {formatBytes(page.contentLength)}</span>
            <span>vision: {page.visionTokensIn}→{page.visionTokensOut} tok · {formatDuration(page.visionLatencyMs)}</span>
            {page.kbIngestedAt && <span>KB ingested {new Date(page.kbIngestedAt).toLocaleString()}</span>}
          </div>
          <S3KeysList page={page} />
        </div>
      </Card>
    </Modal>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12,
        padding: '6px 14px',
        background: 'transparent',
        color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
        border: 'none',
        borderBottom: active ? '2px solid var(--color-primary)' : '2px solid transparent',
        cursor: 'pointer',
        marginBottom: -1,
      }}
    >
      {children}
    </button>
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
      <div
        style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--color-text-tertiary)',
          fontSize: 13,
        }}
      >
        {errored ? 'Failed to load screenshot.' : 'Screenshot has not been uploaded yet.'}
      </div>
    );
  }

  return (
    <img
      src={`/api/ingest/crawl/${encodeURIComponent(crawlId)}/page/${pageIdx}/screenshot`}
      alt="Page screenshot"
      onError={() => setErrored(true)}
      style={{
        width: '100%',
        height: 'auto',
        borderRadius: 4,
        border: '1px solid var(--color-border)',
        display: 'block',
      }}
    />
  );
}

function MarkdownTab({ text }: { text: string }) {
  if (!text) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No extracted text for this page.
      </div>
    );
  }
  return (
    <div style={{ padding: 12, background: 'var(--color-surface-raised)', borderRadius: 4 }}>
      <Markdown size={13}>{text}</Markdown>
    </div>
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
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        Loading analysis…
      </div>
    );
  }
  const analysis = detail?.analysis ?? {
    title: page.title,
    summary: page.summary,
    discoveredLinks: page.discoveredLinks,
  };
  return (
    <pre
      style={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        color: 'var(--color-text-primary)',
        background: 'var(--color-surface-raised)',
        padding: 12,
        borderRadius: 4,
        margin: 0,
      }}
    >
      {JSON.stringify(analysis, null, 2)}
    </pre>
  );
}

function LinksTab({ links }: { links: CrawlPage['discoveredLinks'] }) {
  if (links.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        No links discovered on this page.
      </div>
    );
  }
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableTh>Label</TableTh>
          <TableTh>Target</TableTh>
          <TableTh>Type</TableTh>
          <TableTh style={{ textAlign: 'right' }}>Coords</TableTh>
        </TableRow>
      </TableHead>
      <TableBody>
        {links.map((l, i) => (
          <TableRow key={i}>
            <TableTd style={{ fontSize: 12 }}>{l.label || <em style={{ color: 'var(--color-text-tertiary)' }}>(unlabeled)</em>}</TableTd>
            <TableTd
              style={{
                fontSize: 11,
                fontFamily: 'monospace',
                color: 'var(--color-text-secondary)',
                maxWidth: 360,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
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
              style={{
                textAlign: 'right',
                fontSize: 11,
                fontFamily: 'monospace',
                color: 'var(--color-text-tertiary)',
              }}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {entries.map(e => (
        <div key={e.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
          <span style={{ width: 80, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            {e.label}
          </span>
          {e.key ? (
            <>
              <code
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: 'var(--color-text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
                title={e.key}
              >
                {e.key}
              </code>
              <CopyButton text={e.key} />
            </>
          ) : (
            <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
          )}
        </div>
      ))}
    </div>
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
    <button onClick={copy} style={{ ...smallBtnStyle(false), padding: '1px 6px', fontSize: 10 }}>
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
