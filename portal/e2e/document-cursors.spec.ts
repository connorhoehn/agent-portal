import { test, expect, type Browser } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { openAsClone } from './realSession';

// Disposable readers on the real local gateway. The already-imported document
// may mint a short-lived canvas grant and announce ephemeral presence; no
// text, comment, chat message or call is created (the same floor as the maps).
const DOC_URL = `/assessment/workspace?doc=${encodeURIComponent('page:100002')}`;
const CHANNEL = 'assessment:doc:page:100002';
type Person = Awaited<ReturnType<typeof openAsClone>>;
const cursorFrames: Array<{ user: string; direction: string; at: number; frame: unknown }> = [];
async function evidence(name: string, value: unknown) {
  const path = test.info().outputPath(name);
  await writeFile(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: 'application/json' });
}

async function open(browser: Browser, userId: string, role: string, writes: string[]): Promise<Person> {
  const person = await openAsClone(browser, userId, {
    role, expectTenant: 'assessment', landing: null,
    viewport: { width: 1680, height: 940 }, consoleErrors: true,
    prepare: async context => {
      await context.route('**/api/**', route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
        if (request.method() === 'POST' && ['/api/assessment/knowledge/canvas', '/api/assessment/knowledge/presence'].includes(path)) {
          let body: Record<string, unknown> | null = null;
          try { body = request.postDataJSON(); } catch { /* Malformed requests remain blocked. */ }
          if (path === '/api/assessment/knowledge/canvas' && body?.id === 'page:100002') return route.continue();
          if (path === '/api/assessment/knowledge/presence' && body?.doc_id === 'page:100002') return route.continue();
        }
        writes.push(`${request.method()} ${path}`);
        return route.abort();
      });
    },
  });
  person.page.on('websocket', socket => {
    for (const direction of ['framesent', 'framereceived'] as const) socket.on(direction, event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (frame.channel === CHANNEL && (frame.service === 'cursor' || frame.type === 'cursor')) {
          cursorFrames.push({ user: userId, direction, at: Date.now(), frame });
        }
      } catch { /* Other binary realtime services are outside this proof. */ }
    });
  });
  return person;
}
async function document(person: Person) {
  await person.page.goto(DOC_URL);
  await expect(person.page.getByTestId('document-canvas-slot')).toBeVisible({ timeout: 20_000 });
}
const pointer = (person: Person, label: string) => person.page.getByTestId('cursor-overlay-pointer')
  .filter({ has: person.page.getByTestId('cursor-overlay-label').filter({ hasText: label }) });

async function direction(sender: Person, receiver: Person, name: string, evidence: string) {
  await document(sender);
  await document(receiver);
  await expect(pointer(receiver, name)).toHaveCount(0);
  const box = (await sender.page.getByTestId('document-canvas-slot').boundingBox())!;
  const start = Date.now(); let moves = 0;
  await expect(async () => {
    await sender.page.mouse.move(box.x + box.width * 0.3 + moves++ % 2, box.y + box.height * 0.3);
    await expect(pointer(receiver, name)).toHaveCount(1, { timeout: 500 });
  }).toPass({ timeout: 10_000, intervals: [100, 200] });
  const arriveMs = Date.now() - start;
  await expect(pointer(receiver, name).getByTestId('cursor-overlay-label')).toHaveText(name);
  await expect(pointer(sender, name)).toHaveCount(0);
  const first = (await pointer(receiver, name).boundingBox())!;
  const movedAt = Date.now();
  await sender.page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 4 });
  await expect.poll(async () => (await pointer(receiver, name).boundingBox())?.x ?? first.x).toBeGreaterThan(first.x + 20);
  const followMs = Date.now() - movedAt;
  const next = (await pointer(receiver, name).boundingBox())!;
  await receiver.page.screenshot({ path: test.info().outputPath(evidence) });
  const leftAt = Date.now();
  await sender.page.goto('/assessment/teams');
  await expect(pointer(receiver, name)).toHaveCount(0, { timeout: 10_000 });
  return { name, arriveMs, followMs, leaveMs: Date.now() - leftAt, firstX: first.x, nextX: next.x };
}

test('cloned readers exchange labelled cursors in both directions and an outsider is refused', async ({ browser, request }) => {
  test.setTimeout(90_000);
  cursorFrames.length = 0;
  const health = await (await request.get('/api/health')).json();
  expect(health.profile).toBe('local-ephemeral');
  expect(health.realtime.gateway).toBe('on');
  const people: Person[] = [], writes: string[] = [];
  try {
    const farah = await open(browser, 'u-farah', 'program-lead', writes); people.push(farah);
    const jonas = await open(browser, 'u-jonas', 'lead-assessor', writes); people.push(jonas);
    const forward = await direction(farah, jonas, 'Farah Osei', 'realtime-cursors.jpg');
    const reverse = await direction(jonas, farah, 'Jonas Lindqvist', 'realtime-cursors-reverse.jpg');
    const outsider = await openAsClone(browser, 'u-theo', { expectTenant: 'orgiq', landing: '/', consoleErrors: true }); people.push(outsider);
    const { token } = await (await outsider.context.request.get('/api/session/realtime-token')).json();
    const refusal = await outsider.page.evaluate(({ token, channel }) => new Promise<{ denials: number; cursors: number }>((resolve, reject) => {
      const socket = new WebSocket('ws://localhost:3001/ws', ['bearer-token-v1', token]);
      let denials = 0, cursors = 0;
      const timer = setTimeout(() => { socket.close(); reject(new Error('Both cursor operations must be refused within 8 seconds')); }, 8_000);
      socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error('Cursor refusal socket failed')); };
      socket.onopen = () => {
        socket.send(JSON.stringify({ service: 'cursor', action: 'subscribe', channel }));
        socket.send(JSON.stringify({ service: 'cursor', action: 'update', channel, position: { x: 0.5, y: 0.5 } }));
      };
      socket.onmessage = event => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'cursor') cursors++;
        if (frame.type === 'error' && frame.code === 'AUTHZ_CHANNEL_DENIED') denials++;
        if (denials === 2) { clearTimeout(timer); socket.close(); resolve({ denials, cursors }); }
      };
    }), { token, channel: CHANNEL });
    expect(refusal).toEqual({ denials: 2, cursors: 0 });
    expect(writes).toEqual([]);
    for (const person of people) expect(person.errors).toEqual([]);
    const proof = { audited: new Date().toISOString(), channel: CHANNEL, actors: people.map(p => p.principal), forward, reverse, refusal, writes, consoleErrors: people.flatMap(p => p.errors) };
    await evidence('cursor-proof.json', proof);
  } finally {
    try {
      await evidence('cursor-diagnostics.json', { writes, errors: people.flatMap(p => p.errors), cursorFrames });
    } finally {
      await Promise.all(people.reverse().map(person => person.close()));
    }
  }
});
