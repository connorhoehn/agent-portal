// InterviewPad's frame (contract U2; row I4.2), rendered with react-dom/server from an esbuild bundle (node cannot
// load .tsx), the way voiceDock.test.ts renders the footer. The server render runs no effects, so CodeMirror never
// mounts here: what is proven is the frame each state draws (the row, the notice, the slots) and who gets the
// "Insert a question" menu. Two pads sharing a document, the language following and the inserted block are proven
// on the model in lib/__tests__/interviewsPad.test.ts (two Y.Docs relaying updates), and in a browser by the
// lane's headless walk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORTAL = fileURLToPath(new URL('../../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/interview-pad-test`;

type Render = (opts: { gateway: 'none' | 'offline' | 'live'; seat: 'lead' | 'panel' | 'candidate'; questions?: boolean; interviewId?: string }) => string;

async function bundle(): Promise<{ render: Render }> {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react';
        import { GatewayContext } from '@connorhoehn/realtime-modules/client';
        import { offlineGateway } from './src/components/OptionalGatewayProvider.ts';
        import { InterviewPad } from './src/pages/interviews/pad/InterviewPad.tsx';
        const live = { ...offlineGateway, connectionState: 'connected', sendMessage: () => {}, send: () => {}, onMessage: () => () => {} };
        const QUESTIONS = [{ id: 'q1', prompt: 'Merge two sorted lists.', starter: [{ language: 'python', code: 'def merge(a, b):\\n    pass' }] }];
        export const render = ({ gateway, seat, questions, interviewId }) => {
          const pad = createElement(InterviewPad, { interviewId: interviewId ?? 'iv-k1p5w8ra', self: { userId: 'u-hugo', displayName: 'Hugo' }, seat,
            questions: questions ? QUESTIONS : undefined, toolbarEnd: createElement('i', { 'data-slot': 'end' }), below: createElement('i', { 'data-slot': 'below' }) });
          return renderToStaticMarkup(gateway === 'none' ? pad : createElement(GatewayContext.Provider, { value: gateway === 'live' ? live : offlineGateway }, pad));
        };`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error',
    outfile: `${OUT}/pad.mjs`,
    plugins: [{
      name: 'pad-test-stubs',
      setup(b) { b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: '', loader: 'js' })); },
    }],
  });
  return import(`${OUT}/pad.mjs?${Date.now()}`) as Promise<{ render: Render }>;
}

const connection = (html: string) => /data-testid="interview-pad"[^>]*data-connection="([a-z]+)"/.exec(html)?.[1];

test('with no gateway configured it says so plainly and keeps the slots', async () => {
  const { render } = await bundle();
  for (const gateway of ['none', 'offline'] as const) {
    const html = render({ gateway, seat: 'lead', questions: true });
    assert.equal(connection(html), 'offline');
    assert.match(html, /The shared code pad needs the live connection, and it is not set up here\./);
    assert.match(html, /data-slot="end"/);
    assert.match(html, /data-slot="below"/);
    assert.doesNotMatch(html, /Insert a question/);
  }
});

test('on a live socket it starts connecting, with the language row, the lead\'s menu and both slots', async () => {
  const { render } = await bundle();
  const lead = render({ gateway: 'live', seat: 'lead', questions: true });
  assert.equal(connection(lead), 'connecting');
  assert.match(lead, /data-testid="interview-pad-language"/);
  assert.match(lead, /Python/);
  assert.match(lead, /Insert a question/);
  assert.match(lead, /Connecting…/);
  assert.match(lead, /data-slot="end"/);
  assert.match(lead, /data-slot="below"/);
  assert.doesNotMatch(lead, /style="/, 'no inline styles');
});

test('only the lead with questions gets "Insert a question"', async () => {
  const { render } = await bundle();
  assert.doesNotMatch(render({ gateway: 'live', seat: 'panel', questions: true }), /Insert a question/);
  assert.doesNotMatch(render({ gateway: 'live', seat: 'candidate', questions: true }), /Insert a question/);
  assert.doesNotMatch(render({ gateway: 'live', seat: 'lead' }), /Insert a question/);
});

test('an interview id that cannot name a pad is refused in one plain sentence', async () => {
  const { render } = await bundle();
  const html = render({ gateway: 'live', seat: 'lead', interviewId: 'a:b' });
  assert.equal(connection(html), 'refused');
  assert.match(html, /This code pad is not open to you\./);
});
