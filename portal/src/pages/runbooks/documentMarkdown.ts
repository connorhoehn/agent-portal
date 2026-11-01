// The workspace schema consumes HTML. Use the same guarded GFM parser as the
// existing runbook renderer; no raw HTML, remote images or unsafe link schemes.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { guardMarkdown } from './runbooksModel.ts';

export function documentMarkdownHtml(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: guardMarkdown(markdown) }));
}
