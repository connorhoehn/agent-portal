// Test plumbing for the voice navigator: a virtual clock with timers, a fake
// fetch with a request log, and the middleware's own modules loaded by path
// (so the portal's copies are checked against the real thing, not a fixture).

import type { Palette, ToolContext } from '../tools.ts';
import type { Action } from '../../capabilities';

const MIDDLEWARE = new URL('../../../../../middleware/src/lib/voice/', import.meta.url);

/**
 * middleware/src/lib/voice/<file>, compiled with esbuild (the middleware uses
 * TypeScript that plain type stripping refuses) and imported from a data URL.
 * The files it loads import only types and node builtins.
 */
export async function middlewareVoice<T = Record<string, unknown>>(file: string): Promise<T> {
  const { readFile } = await import('node:fs/promises');
  const { transform } = await import('esbuild');
  const source = await readFile(new URL(file, MIDDLEWARE), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as T;
}

/**
 * The real palette table: components/shell/portalCommands.ts bundled with
 * esbuild (it is React-bound, so node cannot load it), its session hook
 * stubbed out. The tests gate navigate with exactly what the dock passes.
 */
export async function loadPalette(): Promise<Palette & { pages: Array<{ label: string; path: string; tenant: string; roles?: string[]; pageId?: string }> }> {
  const { build } = await import('esbuild');
  const { mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const portal = fileURLToPath(new URL('../../../../', import.meta.url));
  const out = `${portal}node_modules/.cache/voice-dock-test`;
  mkdirSync(out, { recursive: true });
  await build({
    stdin: { contents: "export { PAGES, isPageVisible } from './src/components/shell/portalCommands.ts';", resolveDir: portal, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error', outfile: `${out}/palette.mjs`,
    plugins: [{
      name: 'palette-stubs',
      setup(b) {
        b.onResolve({ filter: /lib\/auth$/ }, () => ({ path: 'auth', namespace: 'stub' }));
        // The compute entry pulls xterm's stylesheet at import; the palette table needs none of it.
        b.onResolve({ filter: /^@connorhoehn\/ui-components\/compute$/ }, () => ({ path: 'compute', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          loader: 'js',
          contents: a.path === 'auth' ? 'export const useSession = () => ({ session: null });'
            : 'export const openShell = () => {}; export const useComputeOptional = () => null;',
        }));
      },
    }],
  });
  const m = await import(`${out}/palette.mjs`) as { PAGES: Palette['pages']; isPageVisible: Palette['visible'] };
  return { pages: [...m.PAGES], visible: m.isPageVisible };
}

export const PALETTE = await loadPalette();

export class FakeClock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimer = (id: unknown): void => { this.timers.delete(id as number); };
  /** Advance in steps, firing due timers in time order and letting promises settle between them. */
  async advance(ms: number, step = 10): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      for (;;) {
        const due = [...this.timers.entries()].filter(([, v]) => v.at <= this.t).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (!due.length) break;
        const [id, timer] = due[0]!;
        this.timers.delete(id);
        timer.fn();
        await flush();
      }
      await flush();
    }
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

export interface LoggedRequest { method: string; url: string; body: unknown }

export type Route = (req: LoggedRequest) => { status: number; body: unknown } | undefined;

export function fakeFetch(routes: Route[]) {
  const log: LoggedRequest[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    const req = { method: init?.method ?? 'GET', url, body };
    log.push(req);
    for (const r of routes) {
      const hit = r(req);
      if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
  };
  return { fetch, log };
}

export const route = (method: string, prefix: string, status: number, body: unknown): Route =>
  (req) => (req.method === method && req.url.startsWith(prefix) ? { status, body } : undefined);

export function toolContext(over: Partial<ToolContext> & { allow?: Action[]; deny?: Action[] } = {}): ToolContext & { navigations: string[] } {
  const navigations: string[] = [];
  const { allow, deny, ...rest } = over;
  return {
    tenant: 'orgiq', role: 'sme', userId: 'u-me', ledger: new Map(), palette: PALETTE, now: () => new Date('2026-11-08T12:00:00Z'),
    can: (a: Action) => (deny ? !deny.includes(a) : allow ? allow.includes(a) : true),
    fetch: async () => { throw new Error('no network in this test'); },
    navigate: (p: string) => { navigations.push(p); },
    ...rest,
    navigations,
  };
}

/** The real live-events log, one parsed object per line (with the probe's t/s/dir fields). */
export async function liveEvents(): Promise<Array<Record<string, unknown>>> {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../../../../../docs/voice/live-events.jsonl', import.meta.url), 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A probe line as the data channel would deliver it: the event without the probe's own fields. */
export function wireEvent(line: Record<string, unknown>): string {
  const { t: _t, s: _s, dir: _d, ...event } = line;
  return JSON.stringify(event);
}
