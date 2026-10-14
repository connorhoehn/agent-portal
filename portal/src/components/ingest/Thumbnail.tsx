import React, { useState } from 'react';
import { Inline } from '@connorhoehnslalom/ui-components/shared';

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

  // Only the dimensions are runtime — they come from props. Everything else
  // about the frame is a class, so `style` carries two numbers instead of a
  // nine-property object.
  const frameClass = [
    'rounded border border-border bg-surface-raised overflow-hidden shrink-0 relative',
    onClick ? 'cursor-pointer' : 'cursor-default',
  ].join(' ');

  if (!hasScreenshot || errored) {
    return (
      <Inline
        gap="none"
        justify="center"
        className={`${frameClass} items-center text-text-tertiary text-xs`}
        style={{ width, height }}
        onClick={onClick}
      >
        {errored ? 'image unavailable' : 'pending…'}
      </Inline>
    );
  }

  return (
    <img
      src={`/api/ingest/crawl/${encodeURIComponent(crawlId)}/page/${pageIdx}/screenshot`}
      alt={`Page ${pageIdx} screenshot`}
      onClick={onClick}
      onError={() => setErrored(true)}
      className={`${frameClass} block h-auto`}
      style={{ width, minHeight: height }}
    />
  );
}
