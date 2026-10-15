// The one way this destination renders runbook, proposal and brief markdown:
// the library MarkdownView (raw HTML is shown as text, javascript:/data: URLs
// are dropped) behind guardMarkdown (images off). A plain .ts file so the
// security test can render it under `node --test`.
import { createElement, type ReactElement } from 'react';
import { MarkdownView } from '@connorhoehnslalom/ui-components/shared';
import { guardMarkdown } from './runbooksModel.ts';

export function SafeMarkdown({ markdown, scale = 'lg', testId = 'runbook-markdown' }: { markdown: string; scale?: 'sm' | 'md' | 'lg'; testId?: string }): ReactElement {
  return createElement(MarkdownView, { markdown: guardMarkdown(markdown), scale, 'data-testid': testId });
}
