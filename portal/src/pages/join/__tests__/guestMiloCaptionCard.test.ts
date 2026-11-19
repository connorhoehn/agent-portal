// The caption card's "Speaking" chip is a visual cue only: the card sits inside a polite live region, and a chip that toggles with
// the voice would make a screen reader read the caption again. Rendered with react-dom/server from an esbuild bundle, as ConsentStep.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORTAL = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/guest-milo-caption-card-test`;

test('the Speaking chip is hidden from assistive technology', async () => {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react';
        import { MiloCaptionCard } from './src/pages/join/GuestMiloVoice.tsx';
        export const render = (speaking) => renderToStaticMarkup(createElement(MiloCaptionCard, { speaking,
          caption: { seq: 1, text: 'How would you design a rate limiter?', kind: 'question', source: 'chat', at: 0 } }));`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error',
    outfile: `${OUT}/card.mjs`,
  });
  const { render } = await import(`${OUT}/card.mjs?${Date.now()}`) as { render: (speaking: boolean) => string };
  const html = render(true);
  // The chip's nearest wrapper carries aria-hidden.
  assert.match(html, /aria-hidden="true"[^>]*><span data-testid="guest-milo-speaking"/);
  assert.equal(render(false).includes('guest-milo-speaking'), false);
  assert.match(html, /How would you design a rate limiter\?/);
});
