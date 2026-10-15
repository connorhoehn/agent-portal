// Run with:  cd portal && node --test src/pages/runbooks/__tests__/markdownSafety.test.ts
// Runbook, proposal and brief markdown is written by people and boxes. A malicious
// runbook fixture is rendered through the same SafeMarkdown the Read tab, the
// proposal review page and the Brief tab use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from '../SafeMarkdown.ts';
import { guardMarkdown } from '../runbooksModel.ts';

const MALICIOUS = `# Rotate keys

<script>alert('xss')</script>

<img src=x onerror="alert(1)">

1. **Open the console.**
   \`\`\`bash
   echo "<script>not a tag, just a command</script>"
   \`\`\`

[run it](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [vbs](vbscript:x) [fine](https://example.com/docs) [here](/iq/runbooks/rb-a)

![tracker](https://evil.example/pixel.png) ![](//evil.example/p.gif) ![ref][r]

[r]: https://evil.example/ref.png

<a href="javascript:alert(2)" onclick="steal()">raw anchor</a> <iframe src="https://evil.example"></iframe>
`;

const html = () => renderToStaticMarkup(createElement(SafeMarkdown, { markdown: MALICIOUS }));

test('no live script, handler, iframe or javascript:/data: URL survives the render', () => {
  const out = html();
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /<iframe/i);
  assert.doesNotMatch(out, /<img/i);
  assert.doesNotMatch(out, /<[a-z][^>]*\son\w+=/i); // no event-handler attribute on a real tag (escaped text is fine)
  assert.doesNotMatch(out, /href="(javascript|data|vbscript):/i);
  assert.doesNotMatch(out, /src="/i);
  assert.doesNotMatch(out, /rel="preload"/i);
});

test('http(s) and in-app links stay; the command inside a fence is shown verbatim', () => {
  const out = html();
  assert.match(out, /href="https:\/\/example.com\/docs"/);
  assert.match(out, /href="\/iq\/runbooks\/rb-a"/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /image omitted/);
});

test('guardMarkdown leaves fenced code alone and swaps images for their alt text', () => {
  const md = 'before ![logo](https://x/y.png) after\n\n```md\n![kept](https://x/z.png)\n```\n';
  const out = guardMarkdown(md);
  assert.match(out, /\(image omitted: logo\)/);
  assert.match(out, /!\[kept\]\(https:\/\/x\/z.png\)/);
});
