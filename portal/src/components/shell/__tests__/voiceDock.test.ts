// The voice dock in the footer (docs/voice-navigator-spec.md §5, §8, §10):
// the gate, the hotkey, the flag's default, and a DOM check that the footer
// renders byte-for-byte what it rendered before the dock existed whenever the
// flag is off or the grant is missing. The DOM check bundles SocialFooter with
// esbuild (node cannot load .tsx) with the session and capability hooks
// stubbed, and renders it with react-dom/server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isVoiceHotkey, voiceDockVisible } from '../voiceDockModel.ts';
import { voiceNavigatorEnabled } from '../../../lib/features.ts';

test('the dock shows only with the flag on, a session, and VoiceNavigate settled true', () => {
  const on = { flag: true, signedIn: true, ready: true, allowed: true };
  assert.equal(voiceDockVisible(on), true);
  for (const k of ['flag', 'signedIn', 'ready', 'allowed'] as const) assert.equal(voiceDockVisible({ ...on, [k]: false }), false, k);
});

test('the flag defaults on under the dev server, off in a build, and the variable wins', () => {
  assert.equal(voiceNavigatorEnabled({ DEV: true }), true);
  assert.equal(voiceNavigatorEnabled({ DEV: false }), false);
  assert.equal(voiceNavigatorEnabled(undefined), false);
  assert.equal(voiceNavigatorEnabled({ DEV: false, VITE_VOICE_NAVIGATOR: '1' }), true);
  assert.equal(voiceNavigatorEnabled({ DEV: true, VITE_VOICE_NAVIGATOR: 'false' }), false);
});

test('Ctrl+Shift+Space is the hotkey, nothing else', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: 'Space', key: ' ', ...o });
  assert.equal(isVoiceHotkey(k({ ctrlKey: true, shiftKey: true })), true);
  assert.equal(isVoiceHotkey(k({ ctrlKey: true })), false);
  assert.equal(isVoiceHotkey(k({ shiftKey: true })), false);
  assert.equal(isVoiceHotkey(k({ ctrlKey: true, shiftKey: true, metaKey: true })), false);
  assert.equal(isVoiceHotkey(k({ ctrlKey: true, shiftKey: true, code: 'KeyK', key: 'K' })), false);
});

const PORTAL = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/voice-dock-test`;

interface VoiceTestGlobals { flag: boolean; allow: string[]; session: Record<string, unknown> | null }
declare global { var __voiceTest: VoiceTestGlobals }

async function bundleFooter(name: string, stubPane: boolean): Promise<{ render(): string }> {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  const featuresPath = `${PORTAL}src/lib/features.ts`;
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import { MemoryRouter } from 'react-router';
        import { SocialFooter } from './src/components/shell/SocialFooter.tsx';
        export const render = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SocialFooter)));`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error',
    outfile: `${OUT}/${name}.mjs`,
    plugins: [{
      name: 'voice-test-stubs',
      setup(b) {
        b.onResolve({ filter: /lib\/auth$/ }, () => ({ path: 'auth', namespace: 'stub' }));
        b.onResolve({ filter: /lib\/capabilities$/ }, () => ({ path: 'caps', namespace: 'stub' }));
        b.onResolve({ filter: /lib\/features$/ }, () => ({ path: 'features', namespace: 'stub' }));
        b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }));
        // The palette table imports the compute entry, which loads xterm's stylesheet at import.
        b.onResolve({ filter: /^@connorhoehn\/ui-components\/compute$/ }, () => ({ path: 'compute', namespace: 'stub' }));
        if (stubPane) b.onResolve({ filter: /\/VoiceFooterPane$/ }, () => ({ path: 'pane', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          loader: 'js', resolveDir: PORTAL,
          contents: {
            auth: 'export const useSession = () => ({ session: globalThis.__voiceTest.session });',
            caps: 'export const useCapabilities = () => ({ can: (x) => globalThis.__voiceTest.allow.includes(x), ready: true, degraded: false, loading: false });',
            features: `export * from ${JSON.stringify(featuresPath)}; export const features = { get voiceNavigator() { return globalThis.__voiceTest.flag; } };`,
            css: '',
            compute: 'export const openShell = () => {}; export const useComputeOptional = () => null;',
            // The footer as it was before the voice navigator: no slot at all.
            pane: 'export const VoiceFooterSlot = () => null;',
          }[a.path] ?? '',
        }));
      },
    }],
  });
  return import(`${OUT}/${name}.mjs?${Date.now()}`) as Promise<{ render(): string }>;
}

test('the footer renders identically with the flag off or without the grant, and shows the dock with both', async () => {
  const [before, footer] = await Promise.all([bundleFooter('footer-before', true), bundleFooter('footer', false)]);
  const session = { sub: 'u1', name: 'Ana', tenant: 'orgiq', role: 'sme', grants: {}, switchable: {}, availableRoles: [], availableTenants: [], masquerading: null };
  globalThis.__voiceTest = { flag: false, allow: ['VoiceNavigate'], session };
  const baseline = before.render();
  assert.match(baseline, /data-testid="shell-footer"/);
  assert.equal(footer.render(), baseline, 'flag off: unchanged');
  globalThis.__voiceTest = { flag: true, allow: [], session };
  assert.equal(footer.render(), baseline, 'flag on, no VoiceNavigate: unchanged');
  globalThis.__voiceTest = { flag: true, allow: ['VoiceNavigate'], session: null };
  assert.equal(footer.render(), before.render(), 'signed out: unchanged');
  globalThis.__voiceTest = { flag: true, allow: ['VoiceNavigate'], session };
  const withDock = footer.render();
  assert.notEqual(withDock, baseline);
  assert.match(withDock, /data-testid="shell-footer-voice"/);
  assert.match(withDock, /data-testid="shell-voice-dock"[^>]*data-phase="off"/);
  const pane = withDock.slice(withDock.indexOf('data-testid="shell-footer-voice"'), withDock.indexOf('data-testid="shell-footer-context"'));
  assert.doesNotMatch(pane, /style=/, 'no inline styles in the voice pane');
});
