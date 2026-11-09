// Test seam for G37 Logging: bundle the real view (and the legacy redirect)
// with esbuild and render it with react-dom/server inside a MemoryRouter, the
// network hook stubbed. Shared by the logging and voice-log tests.

import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORTAL = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/logging-test`;

let built: Promise<{ render(p: unknown, at: string): string; redirect(at: string, route: string): string | null }> | null = null;

function bundle() {
  built ??= (async () => {
    const { build } = await import('esbuild');
    mkdirSync(OUT, { recursive: true });
    const file = `${OUT}/view-${process.pid}.mjs`;
    await build({
      stdin: {
        contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react';
          import { MemoryRouter, Routes, Route } from 'react-router';
          import { LoggingView } from './src/pages/logging/LoggingPage.tsx';
          import LegacyVoiceLogRedirect from './src/pages/logging/LegacyVoiceLogRedirect.tsx';
          export const render = (p, at) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [at] }, createElement(LoggingView, p)));
          // Navigate redirects in an effect, which a server render never runs: the probe calls the redirect inside the
          // matched route (its params and query from the router) and reads where its <Navigate> points.
          export const redirect = (at, route) => { let to = null;
            function Probe() { const el = LegacyVoiceLogRedirect(); to = el.props.to; return null; }
            renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [at] },
              createElement(Routes, null, createElement(Route, { path: route, element: createElement(Probe) }))));
            return to; };`,
        resolveDir: PORTAL, loader: 'tsx',
      },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error', outfile: file,
      plugins: [{
        name: 'logging-stubs',
        setup(b) {
          b.onResolve({ filter: /hooks\/useFetch$/ }, () => ({ path: 'fetch', namespace: 'stub' }));
          b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: a.path === 'fetch' ? 'export const useFetch = () => ({ data: null, error: null, failure: null });' : '' }));
        },
      }],
    });
    try {
      return await import(`${file}?${Date.now()}`) as { render(p: unknown, at: string): string; redirect(at: string, route: string): string | null };
    } finally {
      rmSync(file, { force: true }); // loaded once per process; the per-process name keeps parallel test files apart
    }
  })();
  return built;
}

const noop = () => {};

/** The view at `at`, with no-op handlers unless given. */
export async function renderLogging(props: Record<string, unknown>, at: string): Promise<string> {
  const m = await bundle();
  return m.render({ onSourceChange: noop, onOpen: noop, onCopy: noop, sources: ['voice', 'agents', 'pipelines', 'jobs'], ...props }, at);
}

/** Where the legacy redirect mounted at `route` points for `at` (null when the route did not match). */
export async function landing(at: string, route: string): Promise<string | null> {
  const m = await bundle();
  return m.redirect(at, route);
}
