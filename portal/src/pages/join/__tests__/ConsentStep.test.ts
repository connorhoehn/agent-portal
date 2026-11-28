// The consent step as a fresh guest first sees it (decision 5, row I2.3): nothing is chosen for the candidate, and Continue
// stays off until all three questions have an answer. Rendered with react-dom/server from an esbuild bundle (node cannot load
// .tsx), the way InterviewPad.test.ts renders the pad. The server render runs no effects and takes no clicks, so each state is
// rendered from the answers the server holds: none, two of three, all three.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORTAL = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/consent-step-test`;

type Answers = { recording: boolean | null; transcription: boolean | null; milo: boolean | null };
type Render = (answers: Answers) => string;

async function bundle(): Promise<{ render: Render }> {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react';
        import { ConsentStep } from './src/pages/join/ConsentStep.tsx';
        const notice = { version: 'v1', title: 'Before you begin', paragraphs: ['This interview may use Milo.'] };
        const none = () => {};
        export const render = (answers) => renderToStaticMarkup(createElement(ConsentStep, {
          consents: { notice, answers, answeredAt: null }, onSaved: none, onLinkDead: none, onBack: none, onAdmitted: none }));`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error',
    outfile: `${OUT}/consent.mjs`,
    plugins: [{
      name: 'consent-test-stubs',
      setup(b) { b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: '', loader: 'js' })); },
    }],
  });
  return import(`${OUT}/consent.mjs?${Date.now()}`) as Promise<{ render: Render }>;
}

const PARTS = ['recording', 'transcription', 'milo'] as const;
/** The markup of one question's radio group. */
const group = (html: string, part: string): string => {
  const at = html.indexOf(`data-testid="join-consent-${part}-choice"`);
  assert.ok(at >= 0, `the ${part} question is shown`);
  const end = html.indexOf('data-testid="join-consent-', at + 30);
  return html.slice(at, end < 0 ? undefined : end);
};
const radios = (markup: string): string[] => markup.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
const checked = (markup: string): number => radios(markup).filter((r) => /\schecked(=""|\s|>|\/)/.test(r)).length;
const continueOff = (html: string): boolean => {
  const tag = /<button[^>]*data-testid="join-consents-continue"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(tag, 'Continue is shown');
  return /\sdisabled(=""|\s|>)/.test(tag);
};

test('a fresh guest: the three questions start with nothing selected, and Continue is off', async () => {
  const { render } = await bundle();
  const html = render({ recording: null, transcription: null, milo: null });
  for (const part of PARTS) {
    const g = group(html, part);
    assert.equal(radios(g).length, 2, `${part}: a Yes and a No`);
    assert.equal(checked(g), 0, `${part}: nothing chosen for the candidate`);
  }
  assert.equal(continueOff(html), true);
});

test('Continue stays off until every question has an answer, then turns on', async () => {
  const { render } = await bundle();
  for (const missing of PARTS) {
    const answers: Answers = { recording: true, transcription: true, milo: true };
    answers[missing] = null;
    const html = render(answers);
    assert.equal(checked(group(html, missing)), 0, `${missing} still unanswered`);
    assert.equal(continueOff(html), true, `Continue off with ${missing} unanswered`);
  }
  const all = render({ recording: true, transcription: false, milo: false });
  for (const part of PARTS) assert.equal(checked(group(all, part)), 1, `${part}: its one answer shown`);
  assert.equal(continueOff(all), false);
});

test('each radiogroup has an accessible name: its question, by aria-labelledby', async () => {
  const { render } = await bundle();
  const html = render({ recording: null, transcription: null, milo: null });
  const groups = html.match(/<[a-z]+[^>]*role="radiogroup"[^>]*>/g) ?? [];
  assert.equal(groups.length, 3, 'three radio groups');
  for (const tag of groups) {
    const label = /aria-label="([^"]+)"/.exec(tag)?.[1];
    const by = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
    assert.ok(label || by, `a named group: ${tag}`);
    if (by) {
      for (const id of by.split(' ')) {
        const named = new RegExp(`id="${id}"[^>]*>([^<]+)<`).exec(html)?.[1]?.trim();
        assert.ok(named && named.endsWith('?'), `${id} names the group with its question (${named})`);
      }
    }
  }
});
