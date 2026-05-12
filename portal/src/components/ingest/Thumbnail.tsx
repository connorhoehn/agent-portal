import React, { useState } from 'react';

/**
 * Lazily renders a screenshot from
 *   GET /api/ingest/crawl/:crawlId/page/:idx/screenshot
 *
 * Falls back to a placeholder when the page hasn't yet uploaded its PNG, or
 * when the network request fails.
 */
export function Thumbnail({
  crawlId,
  pageIdx,
  width = 160,
  hasScreenshot,
  onClick,
}: {
  crawlId: string;
  pageIdx: number;
  width?: number;
  hasScreenshot: boolean;
  onClick?: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const aspect = 16 / 10; // 16:10 placeholder; the actual image will set its own ratio
  const height = Math.round(width / aspect);

  const baseStyle: React.CSSProperties = {
    width,
    minHeight: height,
    borderRadius: 4,
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface-raised)',
    cursor: onClick ? 'pointer' : 'default',
    overflow: 'hidden',
    flexShrink: 0,
    position: 'relative',
  };

  if (!hasScreenshot || errored) {
    return (
      <div
        style={{
          ...baseStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-tertiary)',
          fontSize: 10,
          height,
        }}
        onClick={onClick}
      >
        {errored ? 'image unavailable' : 'pending…'}
      </div>
    );
  }

  return (
    <img
      src={`/api/ingest/crawl/${encodeURIComponent(crawlId)}/page/${pageIdx}/screenshot`}
      alt={`Page ${pageIdx} screenshot`}
      onClick={onClick}
      onError={() => setErrored(true)}
      style={{
        ...baseStyle,
        display: 'block',
        height: 'auto',
      }}
    />
  );
}
