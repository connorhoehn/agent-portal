// "No modals" (the owner, this week): the deck editor page's main states and the four new-deck pages render no
// element with role="dialog" or aria-modal. Static markup, as the shell's footer test renders it (esbuild bundles
// the page with the data hooks stubbed; the library itself is real).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORTAL = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/deck-no-modals-test`;

interface DeckTestGlobals { doc: Record<string, unknown> }
declare global { var __deckTest: DeckTestGlobals }

const SPEC = {
  title: 'Auth migration: status', theme: 'product',
  slides: [
    { id: 's1', layout: 'title', title: 'Auth migration', bullets: [], sources: [{ documentId: 'example:template:status-update', title: 'Example' }] },
    { id: 's2', layout: 'chart', title: 'Work status', bullets: [], chart: { kind: 'bar', labels: ['a', 'b'], series: [{ name: 'n', values: [1, 2] }] }, sources: [{ documentId: 'example:template:status-update', title: 'Example' }] },
  ],
};
const DECK = { id: 'idk-1', title: 'Auth migration: status', revisions: [{ id: 'irev-1', label: 'From the Status update template', createdAt: '2026-11-27T10:00:00Z', producedBy: 'template:status-update' }], activeRevisionId: 'irev-1' };

let built: Promise<{ render(what: string, url: string): string }> | null = null;
const bundle = () => (built ??= bundleOnce());
async function bundleOnce(): Promise<{ render(what: string, url: string): string }> {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import { MemoryRouter } from 'react-router';
        import { DeckEditorPage } from './src/components/decks/DeckEditorPage.tsx';
        import NewInitiativeDeckPage from './src/pages/projects/decks/NewInitiativeDeckPage.tsx';
        import NewReviewDeckPage from './src/pages/assessment/decks/NewReviewDeckPage.tsx';
        import NewRunDeckPage from './src/pages/pipelines/decks/NewRunDeckPage.tsx';
        import NewSocialDeckPage from './src/pages/social/decks/NewSocialDeckPage.tsx';
        const api = { getDeck: async () => ({}), getRevisionSpec: async () => ({}), saveRevision: async () => ({}) };
        const editor = (readOnly) => createElement(DeckEditorPage, { deckId: 'idk-1', api, previewDeck: async () => ({ slides: [], warnings: [] }), fileUrl: () => '/f', tenant: 'orgiq', testIdPrefix: 'initiative-deck', readOnly });
        const pages = { editor: () => editor(false), reader: () => editor(true), work: () => createElement(NewInitiativeDeckPage), assessment: () => createElement(NewReviewDeckPage), pipelines: () => createElement(NewRunDeckPage), social: () => createElement(NewSocialDeckPage) };
        export const render = (what, url) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, pages[what]()));`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error',
    outfile: `${OUT}/pages.mjs`,
    plugins: [{
      name: 'deck-test-stubs',
      setup(b) {
        b.onResolve({ filter: /\/useDeckDocument$/ }, () => ({ path: 'doc', namespace: 'stub' }));
        b.onResolve({ filter: /\/ShareToSocialAction$/ }, () => ({ path: 'share', namespace: 'stub' }));
        b.onResolve({ filter: /\/useDeckPresence$/ }, () => ({ path: 'presence', namespace: 'stub' }));
        b.onResolve({ filter: /lib\/conversationCall$/ }, () => ({ path: 'call', namespace: 'stub' }));
        b.onResolve({ filter: /\/HuddleComposerDock$/ }, () => ({ path: 'dock', namespace: 'stub' }));
        b.onResolve({ filter: /lib\/auth$/ }, () => ({ path: 'auth', namespace: 'stub' }));
        b.onResolve({ filter: /lib\/capabilities$/ }, () => ({ path: 'caps', namespace: 'stub' }));
        b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }));
        b.onResolve({ filter: /^@connorhoehn\/ui-components\/compute$/ }, () => ({ path: 'compute', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          loader: 'js', resolveDir: PORTAL,
          contents: {
            doc: 'export const useDeckDocument = () => globalThis.__deckTest.doc;',
            share: 'export const ShareToSocialAction = () => null; export const ShareToSocialPanel = () => null;',
            presence: 'export const DeckPresenceSource = () => null;',
            call: 'export const useCallBlock = () => ({ holds: false, block: null }); export const useCallHost = () => null;',
            dock: 'export const HuddleComposerDock = () => null;',
            auth: 'const session = { sub: "u1", name: "Ana", tenant: "orgiq", role: "sme", grants: {}, switchable: {}, availableRoles: [], availableTenants: [], masquerading: null }; export const useSession = () => ({ session }); export const useOptionalSession = () => ({ session });',
            caps: 'export const useCapabilities = () => ({ can: () => true, ready: true, degraded: false, loading: false });',
            css: '',
            compute: 'export const openShell = () => {}; export const openOutputTab = () => ({ ok: true, id: "" }); export const useComputeOptional = () => null;',
          }[a.path] ?? '',
        }));
      },
    }],
  });
  return import(`${OUT}/pages.mjs?${Date.now()}`) as Promise<{ render(what: string, url: string): string }>;
}

const doc = (over: Record<string, unknown> = {}) => ({
  deck: DECK, loadError: null, reload: async () => DECK, revisionId: 'irev-1', setRevisionId: () => {}, spec: SPEC, setSpec: () => {},
  specError: null, conflict: false, setConflict: () => {}, specRevisionId: 'irev-1', dirty: false, dirtyRef: { current: false }, head: 'irev-1',
  active: DECK.revisions[0], editorRevisions: DECK.revisions.map((r) => ({ id: r.id, label: r.label })), save: async () => {}, loadLatest: () => {}, selectRevision: () => {},
  ...over,
});

const NO_DIALOG = /role="dialog"|aria-modal/;

test('the deck editor page, its reader, its layouts tab and its loading and empty states render no dialog', async () => {
  const pages = await bundle();
  const states: Array<[string, string, Record<string, unknown>, RegExp]> = [
    ['editor', '/iq/decks/idk-1', {}, /data-testid="initiative-deck-editor"/],
    ['editor', '/iq/decks/idk-1?tab=layouts', {}, /data-testid="initiative-deck-editor-layout-panel"/],
    ['editor', '/iq/decks/idk-1', { dirty: true, dirtyRef: { current: true } }, /data-testid="initiative-deck-editor"/],
    ['reader', '/iq/decks/idk-1', {}, /data-testid="initiative-deck-reader"/],
    ['editor', '/iq/decks/idk-1', { deck: null }, /Opening the deck/],
    ['editor', '/iq/decks/idk-1', { spec: null, deck: { ...DECK, revisions: [] } }, /No versions yet/],
  ];
  for (const [what, url, over, shows] of states) {
    globalThis.__deckTest = { doc: doc(over) };
    const html = pages.render(what, url);
    assert.match(html, shows, `${what} ${url} ${JSON.stringify(over)}`);
    assert.doesNotMatch(html, NO_DIALOG, `${what} ${url}: a dialog`);
  }
});

test('the four new-deck pages render inline, with their subject and no dialog', async () => {
  const pages = await bundle();
  globalThis.__deckTest = { doc: doc() };
  for (const [what, url, testId] of [['work', '/iq/decks/new?projectId=p1', 'initiative-deck-new'], ['assessment', '/assessment/decks/new?teamId=t1', 'assessment-deck-new'],
    ['pipelines', '/pipelines/decks/new?runId=r1', 'run-deck-new'], ['social', '/social/decks/new?channel=platform', 'social-deck-new']] as const) {
    const html = pages.render(what, url);
    assert.match(html, new RegExp(`data-testid="${testId}"`), what);
    assert.doesNotMatch(html, NO_DIALOG, `${what}: a dialog`);
    // One h1: the page's (its sections are h2). Inline styles come only from the library's own skeleton tiles.
    assert.equal(html.match(/<h1[ >]/g)?.length, 1, `${what}: one h1`);
  }
});

test('Share to Social is an inline panel in the page flow, not a Modal', async () => {
  const { readFileSync } = await import('node:fs');
  const share = readFileSync(`${PORTAL}src/components/decks/ShareToSocialAction.tsx`, 'utf8');
  assert.doesNotMatch(share, /\bModal\b|role="dialog"|aria-modal/);
  assert.match(share, /export function ShareToSocialPanel/);
  assert.match(share, /<DetailSection title=/);
  assert.match(share, /data-testid="deck-share-panel"/);
  // The page renders it under the toolbar, beside Fill from a report.
  const page = readFileSync(`${PORTAL}src/components/decks/DeckEditorPage.tsx`, 'utf8');
  assert.match(page, /const toolbarPanel = reportPanelNode \?\? sharePanelNode;/);
});
