// The pad's Run control in each runner state (the label before anyone presses Run; Run disabled when nothing can run),
// rendered with react-dom/server from an esbuild bundle as InterviewPad.test.ts does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORTAL = fileURLToPath(new URL('../../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/pad-run-control-test`;

type Render = (runner: 'real' | 'simulated' | 'unavailable' | null, busy?: boolean) => string;

async function bundle(): Promise<{ render: Render }> {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react';
        import { PadRunControl } from './src/pages/interviews/pad/PadRunControl.tsx';
        export const render = (runner, busy) => renderToStaticMarkup(createElement(PadRunControl, { runner, busy: !!busy, onRun: () => {} }));`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error', outfile: `${OUT}/control.mjs`,
    plugins: [{
      name: 'stubs',
      setup(b) { b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: '', loader: 'js' })); },
    }],
  });
  return import(`${OUT}/control.mjs?${Date.now()}`) as Promise<{ render: Render }>;
}

const runButton = (html: string) => /<button[^>]*data-testid="interview-pad-run"[^>]*>/.exec(html)?.[0] ?? '';

test('a simulated runner says so beside Run, and Run stays enabled', async () => {
  const { render } = await bundle();
  const html = render('simulated');
  assert.match(html, /Simulated runner: Run shows example output, it does not execute this code\./);
  assert.doesNotMatch(runButton(html), /disabled/);
});

test('an unavailable runner says so and Run is disabled', async () => {
  const { render } = await bundle();
  const html = render('unavailable');
  assert.match(html, /Running code is not set up here\./);
  assert.match(runButton(html), /disabled/);
});

test('a real runner, or one not yet known, adds nothing and Run is enabled', async () => {
  const { render } = await bundle();
  for (const runner of ['real', null] as const) {
    const html = render(runner);
    assert.doesNotMatch(html, /interview-pad-runner-label/);
    assert.doesNotMatch(runButton(html), /disabled/);
  }
  assert.match(runButton(render('real', true)), /disabled/);
});
