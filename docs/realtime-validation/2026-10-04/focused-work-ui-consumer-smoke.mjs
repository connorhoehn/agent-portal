import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorShell } from '@connorhoehnslalom/ui-components/doc-editor';
const title = 'Refresh loop when a grant is revoked mid-session';
const html = renderToStaticMarkup(React.createElement(EditorShell, {
  title, titleOverflow: 'wrap', titleSize: 'lg', variant: 'work-item', children: null,
}));
const heading = html.match(/<h1[^>]*>[^<]*<\/h1>/)?.[0];
assert.ok(heading?.includes(title));
assert.ok(heading.includes('whitespace-normal') && !heading.includes('truncate'));
console.log('packed EditorShell runtime: PASS');
