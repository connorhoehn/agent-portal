// Typed edit operations and charts from reports (docs/deck-edit-operations.md),
// through the initiative tenant's deck routes: each operation, atomic lists,
// CAS 409, locked slides, limits, the save rule, and every report under a
// caller who may and may not read it. Open-mode authz over a seed-matrix stand-in.

// Sessions here are hand-built (no directory rows): the deck write rule's fresh
// directory re-read (live-principal.ts) is the identity, its Cedar decisions stay real.
jest.mock('../../lib/live-principal.js', () => ({
  ...jest.requireActual('../../lib/live-principal.js'),
  currentLiveSession: async (session: unknown) => session,
}));
// Who is on the initiative (sweep 11): the org-wide roles everywhere, every
// other hand-built session on PID only, and `u-off` on nothing.
jest.mock('../../lib/initiative-scope.js', () => ({
  ...jest.requireActual('../../lib/initiative-scope.js'),
  stewardsInitiative: async (session: { sub?: string; role?: string } | null, id: string) =>
    ['org-leader', 'hr-admin', 'admin'].includes(session?.role ?? '') || (id === 'p-auth-migration' && !!session?.sub && session.sub !== 'u-off'),
}));
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
// The seed matrix for the two actions these routes ask (member: none; sme: dispatch
// but no budgets; program-owner / org-leader / hr-admin: both; admin: wildcard).
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['Search'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['Search', 'DispatchAgentRun', 'ManageSprints'] },
    { id: 'program-owner', tenant: 'orgiq', label: 'PO', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'OL', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
    { id: 'hr-admin', tenant: 'orgiq', label: 'HR', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { initiativeDecksRouter } from '../initiative-decks.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { initiativeDecksFixture, initiativeDeckRevisionsFixture } from '../../mock/initiative-decks.js';
import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';
import { trimForChart, MAX_DECK_OPERATIONS } from '../../lib/deck-shared/index.js';
import { figuresReadAt, REPORT_NOTE_LINE } from '../../lib/deck-shared/reports.js';
import { getSpendReport } from '../../providers/spend-report.js';
import { queueStats } from '../../providers/agent-jobs.js';
import { findingStats } from '../../providers/org-sweeps.js';

const PID = 'p-auth-migration';
const BASE = '/api/initiative-decks';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());
beforeEach(() => { initiativeDecksFixture.reset(); initiativeDeckRevisionsFixture.reset(); });

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use(BASE, requireTenant('orgiq'), initiativeDecksRouter);
  app.use(errorHandler);
  return app;
}
const as = (role: string) => appAs({ role: role as Session['role'], tenant: 'orgiq', sub: `u-${role}` });

async function build(app: express.Express, body: Record<string, unknown> = {}) {
  const res = await request(app).post(`${BASE}/projects/${PID}`).send(body);
  expect(res.status).toBe(201);
  const spec: DeckSpec = (await request(app).get(`${BASE}/${res.body.deckId}/revisions/${res.body.revisionId}/spec`)).body;
  return { ...res.body, spec } as { deckId: string; revisionId: string; spec: DeckSpec };
}
const specOf = async (app: express.Express, deckId: string, rid: string): Promise<DeckSpec> =>
  (await request(app).get(`${BASE}/${deckId}/revisions/${rid}/spec`)).body;
const ops = (app: express.Express, deckId: string, baseRevisionId: string, operations: unknown[]) =>
  request(app).post(`${BASE}/${deckId}/operations`).send({ baseRevisionId, operations });

const TIMELINE = [{ date: 'Jan', label: 'Plan' }, { date: 'Feb', label: 'Build' }, { date: 'Mar', label: 'Ship' }];

describe('typed edit operations', () => {
  it('add_slide places a timeline after a slide, mints its id, records the producer and summary', async () => {
    const app = as('sme');
    const made = await build(app);
    const after = made.spec.slides[1]!.id;
    const res = await ops(app, made.deckId, made.revisionId, [{ op: 'add_slide', layout: 'timeline', after, title: 'Plan', fields: { timeline: TIMELINE } }]);
    expect(res.status).toBe(201);
    const [id] = res.body.touchedSlideIds as string[];
    expect(id).toMatch(/^s-[0-9a-f]{8}$/);
    expect(res.body.revision.producedBy).toBe('operations:u-sme');
    expect(res.body.summary).toMatch(/^Added a timeline slide at slide 3\.$/);
    // A slide added to an initiative's deck cites the initiative record (finding 3), not a placeholder.
    expect(res.body.exampleSourceSlideIds).toEqual([]);
    expect(Array.isArray(res.body.findings)).toBe(true);
    const spec = await specOf(app, made.deckId, res.body.revision.id);
    expect(spec.slides[2]).toMatchObject({ id, layout: 'timeline', title: 'Plan', timeline: TIMELINE, sources: [{ documentId: `initiative:${PID}` }] });
    const preview = await request(app).post(`${BASE}/${made.deckId}/preview`).send({ spec });
    expect(preview.body.warnings.join('\n')).not.toContain(`Slide 3 (${id}) cites only a placeholder`);
  });

  it('add_slide at the end with starter content; remove, move, retitle, notes, fields, layout and theme each apply', async () => {
    const app = as('sme');
    const made = await build(app);
    const ids = made.spec.slides.map((s) => s.id);
    let rid = made.revisionId;
    const step = async (op: Record<string, unknown>) => {
      const res = await ops(app, made.deckId, rid, [op]);
      expect(res.status).toBe(201);
      rid = res.body.revision.id;
      return { res, spec: await specOf(app, made.deckId, rid) };
    };
    let r = await step({ op: 'add_slide', layout: 'agenda' });
    expect(r.spec.slides.at(-1)).toMatchObject({ layout: 'agenda', title: 'Agenda', agenda: { items: ['Where we are', 'What comes next'] } });
    r = await step({ op: 'remove_slide', slideId: ids[1] });
    expect(r.spec.slides.map((s) => s.id)).not.toContain(ids[1]);
    expect(r.res.body.touchedSlideIds).toEqual([]);
    r = await step({ op: 'move_slide', slideId: ids[2], to: 'start' });
    expect(r.spec.slides[0]!.id).toBe(ids[2]);
    r = await step({ op: 'move_slide', slideId: ids[2], after: ids[3] });
    expect(r.spec.slides.findIndex((s) => s.id === ids[2])).toBe(r.spec.slides.findIndex((s) => s.id === ids[3]) + 1);
    r = await step({ op: 'set_title', slideId: ids[0], title: 'A new title' });
    expect(r.spec.slides.find((s) => s.id === ids[0])!.title).toBe('A new title');
    r = await step({ op: 'set_notes', slideId: ids[0], notes: 'Say this slowly.' });
    expect(r.spec.slides.find((s) => s.id === ids[0])!.notes).toBe('Say this slowly.');
    r = await step({ op: 'set_fields', slideId: ids[0], fields: { eyebrow: 'Update', bullets: ['One', 'Two'] } });
    expect(r.spec.slides.find((s) => s.id === ids[0])).toMatchObject({ eyebrow: 'Update', bullets: ['One', 'Two'] });
    r = await step({ op: 'change_layout', slideId: ids[0], layout: 'agenda' });
    expect(r.spec.slides.find((s) => s.id === ids[0])).toMatchObject({ layout: 'agenda', agenda: { items: ['One', 'Two'] } });
    expect(r.spec.slides.find((s) => s.id === ids[0])!.bullets).toBeUndefined();
    r = await step({ op: 'set_theme', theme: 'engineering' });
    expect(r.spec.theme).toBe('engineering');
    r = await step({ op: 'set_theme', theme: { ref: 'orgiq' } });
    expect(r.spec.theme).toEqual({ ref: 'orgiq' });
  });

  it('set_fields refuses a field the layout does not own, and a bad value names the field', async () => {
    const app = as('sme');
    const made = await build(app);
    const id = made.spec.slides.find((s) => s.layout === 'bullets')!.id;
    const wrong = await ops(app, made.deckId, made.revisionId, [{ op: 'set_fields', slideId: id, fields: { timeline: TIMELINE } }]);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/operation 1 \(set_fields\): timeline does not belong to a 'bullets' slide/);
    const bad = await ops(app, made.deckId, made.revisionId, [{ op: 'set_fields', slideId: id, fields: { bullets: ['x'.repeat(300)] } }]);
    expect(bad.status).toBe(400);
    expect(bad.body.errors.join('\n')).toMatch(/bullets\[0\]: longer than 200/);
    const theme = await ops(app, made.deckId, made.revisionId, [{ op: 'set_theme', theme: { ref: 'assessment' } }]);
    expect(theme.status).toBe(400);
  });

  it('a mixed list applies as one revision; a bad fifth operation leaves nothing saved', async () => {
    const app = as('sme');
    const made = await build(app);
    const [a, b] = made.spec.slides.map((s) => s.id);
    const good = [
      { op: 'add_slide', layout: 'chart', title: 'Numbers' },
      { op: 'set_title', slideId: a, title: 'Renamed' },
      { op: 'set_notes', slideId: b, notes: 'n' },
      { op: 'set_theme', theme: 'plain' },
    ];
    const before = initiativeDeckRevisionsFixture.rows().length;
    const broken = await ops(app, made.deckId, made.revisionId, [...good, { op: 'set_title', slideId: 'nope', title: 'x' }]);
    expect(broken.status).toBe(404);
    expect(broken.body.error).toMatch(/^operation 5 \(set_title\)/);
    expect(initiativeDeckRevisionsFixture.rows().length).toBe(before);
    // A chart slide without data is not a valid deck: the whole list is refused.
    const invalid = await ops(app, made.deckId, made.revisionId, good);
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.join('\n')).toMatch(/needs a chart/);
    const chartData = { labels: ['A', 'B'], series: [{ name: 'Count', values: [3, 4] }] };
    const ok = await ops(app, made.deckId, made.revisionId, [...good, { op: 'set_chart', slideId: '__last__', kind: 'bar', data: chartData }].map((o) => o));
    expect(ok.status).toBe(404); // a set_chart must name a real slide id
    const mixed = await ops(app, made.deckId, made.revisionId, [
      { op: 'add_slide', layout: 'chart', title: 'Numbers', fields: { chart: { kind: 'bar', ...chartData } } }, ...good.slice(1),
    ]);
    expect(mixed.status).toBe(201);
    expect(mixed.body.touchedSlideIds).toHaveLength(3);
    expect(initiativeDeckRevisionsFixture.rows().length).toBe(before + 1);
    expect(mixed.body.summary.split('; ')).toHaveLength(4);
  });

  it('a stale base is 409 with the head; a locked slide is 409; more than the limit is 400', async () => {
    const app = as('sme');
    const made = await build(app);
    const [a, b] = made.spec.slides.map((s) => s.id);
    const first = await ops(app, made.deckId, made.revisionId, [{ op: 'set_title', slideId: a, title: 'One' }]);
    const stale = await ops(app, made.deckId, made.revisionId, [{ op: 'set_title', slideId: a, title: 'Two' }]);
    expect(stale.status).toBe(409);
    expect(stale.body.activeRevisionId).toBe(first.body.revision.id);
    const spec = await specOf(app, made.deckId, first.body.revision.id);
    const locked = await request(app).post(`${BASE}/${made.deckId}/revisions`).send({ spec, baseRevisionId: first.body.revision.id, lockedSlideIds: [b] });
    expect(locked.status).toBe(201);
    for (const op of [{ op: 'set_title', slideId: b, title: 'x' }, { op: 'remove_slide', slideId: b }, { op: 'move_slide', slideId: b, to: 'start' }]) {
      const res = await ops(app, made.deckId, locked.body.id, [op]);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/is locked/);
    }
    const many = Array.from({ length: MAX_DECK_OPERATIONS + 1 }, () => ({ op: 'set_notes', slideId: a, notes: 'n' }));
    expect((await ops(app, made.deckId, locked.body.id, many)).status).toBe(400);
    expect((await ops(app, made.deckId, locked.body.id, [])).status).toBe(400);
    expect((await ops(app, made.deckId, locked.body.id, [{ op: 'explode' }])).status).toBe(400);
  });

  it('the save rule decides: a member, a non-member of the initiative and another tenant are refused', async () => {
    const made = await build(as('sme'));
    const op = [{ op: 'set_title', slideId: made.spec.slides[0]!.id, title: 'x' }];
    expect((await ops(as('member'), made.deckId, made.revisionId, op)).status).toBe(403);
    const off = appAs({ role: 'sme' as Session['role'], tenant: 'orgiq', sub: 'u-off' });
    expect((await ops(off, made.deckId, made.revisionId, op)).status).toBe(403);
    const other = appAs({ role: 'sme' as Session['role'], tenant: 'assessment', sub: 'u-sme' });
    expect((await ops(other, made.deckId, made.revisionId, op)).status).toBe(403);
    expect((await ops(as('sme'), 'adk-00000000-0000-0000-0000-000000000000', made.revisionId, op)).status).toBe(404);
  });
});

describe('styles, decorations, emphasis and the designed layouts', () => {
  it('set_style rides on the theme reference; set_theme keeps it; an unknown style is refused', async () => {
    const app = as('sme');
    const made = await build(app);
    const styled = await ops(app, made.deckId, made.revisionId, [{ op: 'set_style', style: 'editorial' }]);
    expect(styled.status).toBe(201);
    expect(styled.body.summary).toBe('Set the style to editorial.');
    expect((await specOf(app, made.deckId, styled.body.revision.id)).theme).toEqual({ ref: 'orgiq-editorial' });
    const themed = await ops(app, made.deckId, styled.body.revision.id, [{ op: 'set_theme', theme: 'plain' }]);
    expect((await specOf(app, made.deckId, themed.body.revision.id)).theme).toEqual({ ref: 'plain-editorial' });
    const bad = await ops(app, made.deckId, themed.body.revision.id, [{ op: 'set_style', style: 'baroque' }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/operation 1 \(set_style\): style must be one of bold, editorial, minimal, playful, corporate/);
  });

  it("set_decoration puts a graphic on a slide, removes it with 'none', returns to the style's own with null", async () => {
    const app = as('sme');
    const made = await build(app);
    const id = made.spec.slides[1]!.id;
    let res = await ops(app, made.deckId, made.revisionId, [{ op: 'set_decoration', slideId: id, decoration: { graphic: 'badge-seal', placement: 'corner' } }]);
    expect(res.status).toBe(201);
    expect(res.body.summary).toBe('Put a badge seal on slide 2.');
    expect((await specOf(app, made.deckId, res.body.revision.id)).slides[1]!.decoration).toEqual({ graphic: 'badge-seal', placement: 'corner' });
    res = await ops(app, made.deckId, res.body.revision.id, [{ op: 'set_decoration', slideId: id, decoration: 'none' }]);
    expect((await specOf(app, made.deckId, res.body.revision.id)).slides[1]!.decoration).toBe('none');
    res = await ops(app, made.deckId, res.body.revision.id, [{ op: 'set_decoration', slideId: id, decoration: null }]);
    expect((await specOf(app, made.deckId, res.body.revision.id)).slides[1]!.decoration).toBeUndefined();
    const rid = res.body.revision.id;
    expect((await ops(app, made.deckId, rid, [{ op: 'set_decoration', slideId: id, decoration: { graphic: 'unicorn' } }])).status).toBe(400);
    const placed = await ops(app, made.deckId, rid, [{ op: 'set_decoration', slideId: id, decoration: { graphic: 'dots', placement: 'footer' } }]);
    expect(placed.body.error).toMatch(/decoration\.placement must be one of corner, background, title/);
  });

  it('set_emphasis marks words of a title or a bullet, keeps the other runs, clears with null, and counts words', async () => {
    const app = as('sme');
    const made = await build(app);
    const slide = made.spec.slides.find((s) => s.layout === 'bullets' && (s.bullets?.length ?? 0) > 0)!;
    const add = await ops(app, made.deckId, made.revisionId, [{ op: 'set_title', slideId: slide.id, title: 'Three quick wins' }]);
    let rid = add.body.revision.id;
    let res = await ops(app, made.deckId, rid, [
      { op: 'set_emphasis', slideId: slide.id, target: 'title', from: 2, to: 3, emphasis: 'highlight' },
      { op: 'set_emphasis', slideId: slide.id, target: 'title', from: 1, emphasis: 'bold' },
      { op: 'set_emphasis', slideId: slide.id, target: { bullet: 1 }, from: 1, emphasis: 'accent' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatch(/^Gave highlight emphasis to words 2 to 3 of the title on slide \d+; gave bold emphasis to word 1/);
    let after = (await specOf(app, made.deckId, res.body.revision.id)).slides.find((s) => s.id === slide.id)!;
    // The space between two marked runs joins the run before it (the engine refuses a run of only spaces).
    expect(after.title).toEqual([{ text: 'Three ', emphasis: 'bold' }, { text: 'quick wins', emphasis: 'highlight' }]);
    expect(Array.isArray(after.bullets![0])).toBe(true);
    expect((after.bullets![0] as Array<{ emphasis?: string }>)[0]!.emphasis).toBe('accent');
    rid = res.body.revision.id;
    res = await ops(app, made.deckId, rid, [{ op: 'set_emphasis', slideId: slide.id, target: 'title', from: 1, to: 3, emphasis: null }]);
    after = (await specOf(app, made.deckId, res.body.revision.id)).slides.find((s) => s.id === slide.id)!;
    expect(after.title).toBe('Three quick wins');
    rid = res.body.revision.id;
    const far = await ops(app, made.deckId, rid, [{ op: 'set_emphasis', slideId: slide.id, target: 'title', from: 4, emphasis: 'bold' }]);
    expect(far.body.error).toMatch(/words 4 to 4: the text has 3 words/);
    const bullet = await ops(app, made.deckId, rid, [{ op: 'set_emphasis', slideId: slide.id, target: { bullet: 99 }, from: 1, emphasis: 'bold' }]);
    expect(bullet.body.error).toMatch(/there is no bullet 99/);
    const kind = await ops(app, made.deckId, rid, [{ op: 'set_emphasis', slideId: slide.id, target: 'title', from: 1, emphasis: 'sparkle' }]);
    expect(kind.body.error).toMatch(/emphasis must be one of highlight, accent, bold, underline, outline, gradient/);
  });

  it('the designed layouts through add_slide, set_fields and change_layout, with icons checked by the engine', async () => {
    const app = as('sme');
    const made = await build(app);
    const items = [{ title: 'Faster', text: 'Logins in under a second', icon: 'zap' }, { title: 'Safer', text: 'Keys rotate weekly', icon: 'shield-check' }, { title: 'Cheaper', icon: 'piggy-bank' }];
    const matrix = { x: ['Low effort', 'High effort'], y: ['Low value', 'High value'], quadrants: [{ title: 'Later' }, { title: 'Avoid' }, { title: 'Quick wins', icon: 'trophy' }, { title: 'Big bets' }] };
    const funnel = [{ label: 'Invited', value: '120' }, { label: 'Signed in', value: '84' }, { label: 'Migrated', value: '61' }];
    const res = await ops(app, made.deckId, made.revisionId, [
      { op: 'add_slide', layout: 'cards', title: 'What changes', fields: { items } },
      { op: 'add_slide', layout: 'matrix', title: 'Where to start', fields: { matrix } },
      { op: 'add_slide', layout: 'funnel', title: 'Who has moved', fields: { funnel } },
      { op: 'add_slide', layout: 'big-number', title: [{ text: 'Logins ' }, { text: 'doubled', emphasis: 'gradient' }], fields: { figures: [{ value: '2x', label: 'logins per day', icon: 'trending-up' }] } },
      { op: 'add_slide', layout: 'process' },
      { op: 'add_slide', layout: 'people' },
    ]);
    expect(res.status).toBe(201);
    const spec = await specOf(app, made.deckId, res.body.revision.id);
    const added = spec.slides.slice(-6);
    expect(added.map((s) => s.layout)).toEqual(['cards', 'matrix', 'funnel', 'big-number', 'process', 'people']);
    expect(added[0]).toMatchObject({ items });
    expect(added[1]).toMatchObject({ matrix });
    expect(added[2]).toMatchObject({ funnel });
    expect(added[3]!.title).toEqual([{ text: 'Logins ' }, { text: 'doubled', emphasis: 'gradient' }]);
    // Starter words fill a designed layout added without its payload.
    expect(added[4]!.items!.length).toBeGreaterThan(1);
    expect(added[5]!.people!.length).toBeGreaterThan(0);
    const rid = res.body.revision.id;
    // set_fields edits a card's icon; an icon outside the catalogue is refused, naming the field.
    const edited = await ops(app, made.deckId, rid, [{ op: 'set_fields', slideId: added[0]!.id, fields: { items: [{ ...items[0], icon: 'rocket' }, ...items.slice(1)] } }]);
    expect(edited.status).toBe(201);
    expect((await specOf(app, made.deckId, edited.body.revision.id)).slides.find((s) => s.id === added[0]!.id)!.items![0]!.icon).toBe('rocket');
    const badIcon = await ops(app, made.deckId, edited.body.revision.id, [{ op: 'set_fields', slideId: added[0]!.id, fields: { items: [{ title: 'x', icon: 'not-an-icon' }, ...items.slice(1)] } }]);
    expect(badIcon.status).toBe(400);
    expect(badIcon.body.error).toMatch(/items is not valid/);
    // bullets carry into cards; a matrix does not draw bullets, so moving there drops them.
    const bullets = spec.slides.find((s) => s.layout === 'bullets' && (s.bullets?.length ?? 0) > 1)!;
    const toCards = await ops(app, made.deckId, edited.body.revision.id, [{ op: 'change_layout', slideId: bullets.id, layout: 'cards' }]);
    expect(toCards.status).toBe(201);
    const carded = (await specOf(app, made.deckId, toCards.body.revision.id)).slides.find((s) => s.id === bullets.id)!;
    expect(carded.items!.length).toBe(Math.min(bullets.bullets!.length, carded.items!.length));
    expect(carded.bullets).toBeUndefined();
    const other = await build(app);
    const otherBullets = other.spec.slides.find((s) => s.layout === 'bullets' && (s.bullets?.length ?? 0) > 1)!;
    const toMatrix = await ops(app, other.deckId, other.revisionId, [{ op: 'change_layout', slideId: otherBullets.id, layout: 'matrix' }]);
    expect(toMatrix.status).toBe(201);
    const moved = (await specOf(app, other.deckId, toMatrix.body.revision.id)).slides.find((s) => s.id === otherBullets.id)!;
    expect(moved).toMatchObject({ layout: 'matrix', matrix: expect.any(Object) });
    expect(moved.bullets).toBeUndefined();
  });

  it('an image url is refused in operations and in a person save; an assetId is accepted', async () => {
    const app = as('sme');
    const made = await build(app);
    const byUrl = await ops(app, made.deckId, made.revisionId, [{ op: 'add_slide', layout: 'image-text', fields: { image: { alt: 'A chart', url: 'https://example.com/a.png' } } }]);
    expect(byUrl.status).toBe(400);
    expect(byUrl.body.errors.join('\n')).toMatch(/url/i);
    const byAsset = await ops(app, made.deckId, made.revisionId, [{ op: 'add_slide', layout: 'image-text', fields: { image: { alt: 'A chart', assetId: 'asset-1' } } }]);
    expect(byAsset.status).toBe(201);
    const spec = await specOf(app, made.deckId, byAsset.body.revision.id);
    const imaged = spec.slides.at(-1)!;
    imaged.image = { alt: 'A chart', url: 'https://example.com/a.png' };
    const saved = await request(app).post(`${BASE}/${made.deckId}/revisions`).send({ spec, baseRevisionId: byAsset.body.revision.id });
    expect(saved.status).toBe(400);
    expect(JSON.stringify(saved.body)).toMatch(/url/i);
  });

  it('a chart on a bullets slide makes it a chart slide and drops the bullets, saying so; a kpi slide keeps its layout', async () => {
    const app = as('sme');
    const made = await build(app);
    const slide = made.spec.slides.find((s) => s.layout === 'bullets' && (s.bullets?.length ?? 0) > 0)!;
    const data = { labels: ['A', 'B'], series: [{ name: 'Count', values: [3, 4] }] };
    const res = await ops(app, made.deckId, made.revisionId, [{ op: 'set_chart', slideId: slide.id, kind: 'bar', data }]);
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatch(/\(it was a bullets slide; dropped bullets\)\.$/);
    const after = (await specOf(app, made.deckId, res.body.revision.id)).slides.find((s) => s.id === slide.id)!;
    expect(after).toMatchObject({ layout: 'chart', chart: { kind: 'bar', ...data } });
    expect(after.bullets).toBeUndefined();
    const kpiRes = await ops(app, made.deckId, res.body.revision.id, [{ op: 'add_slide', layout: 'kpi', title: 'Logins', fields: { figures: [{ value: '61', label: 'migrated' }, { value: '84', label: 'signed in' }], chart: { kind: 'line', ...data } } }]);
    expect(kpiRes.status).toBe(201);
    const kpiId = kpiRes.body.touchedSlideIds[0] as string;
    const again = await ops(app, made.deckId, kpiRes.body.revision.id, [{ op: 'set_chart', slideId: kpiId, kind: 'bar', data }]);
    expect(again.status).toBe(201);
    expect(again.body.summary).not.toMatch(/it was a/);
    expect((await specOf(app, made.deckId, again.body.revision.id)).slides.find((s) => s.id === kpiId)).toMatchObject({ layout: 'kpi', chart: { kind: 'bar' } });
  });
});

describe('charts from reports', () => {
  it('lists the reports this caller may use: money reports only at the budget tier', async () => {
    const made = await build(as('sme'));
    const sme = (await request(as('sme')).get(`${BASE}/${made.deckId}/chart-reports`)).body.reports.map((r: { id: string }) => r.id);
    expect(sme).toEqual(['runs-by-outcome', 'findings-by-severity', 'jobs-by-status']);
    const owner = (await request(as('program-owner')).get(`${BASE}/${made.deckId}/chart-reports`)).body.reports;
    expect(owner.map((r: { id: string }) => r.id)).toEqual(['spend-by-initiative', 'spend-by-model', 'runs-by-outcome', 'findings-by-severity', 'jobs-by-status']);
    expect(owner[0]).toMatchObject({ params: [{ name: 'period', required: false }], money: true });
  });

  it('spend-by-initiative as a pie: the top five and Other, exactly the report, cited with its period, noted with the read time', async () => {
    const app = as('program-owner');
    const made = await build(app, { includeBudget: false });
    const slideId = made.spec.slides[1]!.id;
    const res = await ops(app, made.deckId, made.revisionId, [{ op: 'set_chart', slideId, kind: 'pie', report: { report: 'spend-by-initiative', params: { period: '30d' } } }]);
    expect(res.status).toBe(201);
    const slide = (await specOf(app, made.deckId, res.body.revision.id)).slides.find((s) => s.id === slideId)!;
    const report = await getSpendReport({ groupBy: 'initiative', period: '30d', sources: 'work' });
    const groups = report.groups.filter((g) => g.knownUsd > 0).sort((x, y) => y.knownUsd - x.knownUsd);
    const cents = (n: number) => Math.round(n * 100) / 100;
    const expected = trimForChart({ labels: groups.map((g) => g.label || (g.key ?? 'Unattributed')), series: [{ name: 'Spend (USD)', values: groups.map((g) => cents(g.knownUsd)) }] }, 'pie');
    expect(slide.layout).toBe('chart');
    expect(slide.chart).toEqual({ kind: 'pie', labels: expected.labels.map((l) => l.slice(0, 40)), series: expected.series });
    expect(slide.sources[0]).toMatchObject({ documentId: 'report:spend-by-initiative', title: expect.stringContaining(report.periodStart.slice(0, 10)) });
    // Read aloud: a plain date and time, never a machine timestamp.
    expect(slide.notes).toMatch(/^Figures read \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC from the report "Spend by initiative, /m);
    expect(slide.notes).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    if (groups.length > 6) expect(res.body.summary).toContain('top 5 and Other');
    // The slide takes the report's title, and the summary names the old and the new one.
    expect(slide.title).toMatch(/^Spend by initiative, /);
    expect(res.body.summary).toContain(`renamed it from "${made.spec.slides[1]!.title}" to "${slide.title}"`);
    // Filled again: still one "Figures read" line; a title passed with the operation wins over the report's.
    const again = await ops(app, made.deckId, res.body.revision.id, [{ op: 'set_chart', slideId, kind: 'pie', title: 'Where the money went', report: { report: 'spend-by-initiative', params: { period: '7d' } } }]);
    expect(again.status).toBe(201);
    const after = (await specOf(app, made.deckId, again.body.revision.id)).slides.find((s) => s.id === slideId)!;
    expect(after.notes!.split('\n').filter((l) => l.startsWith('Figures read '))).toHaveLength(1);
    expect(after.title).toBe('Where the money went');
    expect(again.body.summary).toContain('titled "Where the money went"');
  });

  it('figuresReadAt says the time in words a presenter reads', () => {
    expect(figuresReadAt(new Date('2026-11-29T14:05:07.951Z'))).toBe('Figures read 29 November 2026, 14:05 UTC');
    expect(REPORT_NOTE_LINE.test('Chart data read from the spend-by-initiative report at 2026-11-28T00:05:07.951Z.')).toBe(true);
  });

  it('a money report below the budget tier is refused (403), never charted without dollars', async () => {
    const app = as('sme');
    const made = await build(app);
    for (const report of ['spend-by-initiative', 'spend-by-model']) {
      const res = await ops(app, made.deckId, made.revisionId, [{ op: 'set_chart', slideId: made.spec.slides[0]!.id, kind: 'bar', report: { report } }]);
      expect(res.status).toBe(403);
    }
  });

  it('runs-by-outcome defaults to the deck initiative; findings and jobs equal their providers', async () => {
    const app = as('sme');
    const made = await build(app);
    const [a, b, c] = made.spec.slides.map((s) => s.id);
    const runs = (await getSpendReport({ groupBy: 'initiative', period: 'month', initiativeId: PID, sources: 'work' })).initiative!.runs.byStatus;
    const jobs = await queueStats();
    const open = (await findingStats()).filter((r) => r.status === 'open');
    const operations = [
      runs.done + runs.failed + runs.skipped + runs.running > 0 ? { op: 'set_chart', slideId: a, kind: 'bar', report: { report: 'runs-by-outcome' } } : null,
      jobs.total > 0 ? { op: 'set_chart', slideId: b, kind: 'bar', report: { report: 'jobs-by-status' } } : null,
      open.length ? { op: 'set_chart', slideId: c, kind: 'bar', report: { report: 'findings-by-severity' } } : null,
    ].filter(Boolean);
    expect(operations.length).toBeGreaterThan(0);
    const res = await ops(app, made.deckId, made.revisionId, operations);
    expect(res.status).toBe(201);
    const spec = await specOf(app, made.deckId, res.body.revision.id);
    const chartOf = (id: string) => spec.slides.find((s) => s.id === id)!.chart!;
    if (operations.some((o) => o!.slideId === a)) expect(chartOf(a!).series[0]!.values).toEqual([runs.done, runs.failed, runs.skipped, runs.running]);
    if (operations.some((o) => o!.slideId === b)) expect(chartOf(b!).series[0]!.values.reduce((x, y) => x + y, 0)).toBe(jobs.total);
    if (operations.some((o) => o!.slideId === c)) expect(chartOf(c!).series[0]!.values.reduce((x, y) => x + y, 0)).toBe(open.reduce((t, r) => t + r.n, 0));
  });

  it('an unknown report is 404, bad params are 400, explicit data past the limits is refused', async () => {
    const app = as('sme');
    const made = await build(app);
    const id = made.spec.slides[0]!.id;
    const one = (o: Record<string, unknown>) => ops(app, made.deckId, made.revisionId, [{ op: 'set_chart', slideId: id, ...o }]);
    expect((await one({ kind: 'bar', report: { report: 'salaries' } })).status).toBe(404);
    expect((await one({ kind: 'bar', report: { report: 'jobs-by-status', params: { period: 'year' } } })).status).toBe(400);
    expect((await one({ kind: 'bar', report: { report: 'runs-by-outcome', params: { period: 'forever' } } })).status).toBe(400);
    const labels = Array.from({ length: 25 }, (_, i) => `L${i}`);
    expect((await one({ kind: 'bar', data: { labels, series: [{ name: 'x', values: labels.map(() => 1) }] } })).body.error).toMatch(/25 labels, the cap is 24/);
    expect((await one({ kind: 'pie', data: { labels: labels.slice(0, 7), series: [{ name: 'x', values: [1, 1, 1, 1, 1, 1, 1] }] } })).status).toBe(400);
    expect((await one({ kind: 'pie', data: { labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [1, 2] }] } })).status).toBe(400);
    expect((await one({ kind: 'bar', data: { labels: ['a'], series: [{ name: 'x', values: ['1'] }] } })).status).toBe(400);
    expect((await one({ kind: 'bar' })).status).toBe(400);
  });

  it('trimForChart folds the tail into Other and never changes a kept value', () => {
    const labels = Array.from({ length: 9 }, (_, i) => `I${i}`);
    const values = [9, 8, 7, 6, 5, 4, 3, 2, 1];
    const pie = trimForChart({ labels, series: [{ name: 's', values }] }, 'pie');
    expect(pie).toEqual({ labels: ['I0', 'I1', 'I2', 'I3', 'I4', 'Other'], series: [{ name: 's', values: [9, 8, 7, 6, 5, 10] }], trimmed: 'top 5 and Other' });
    expect(trimForChart({ labels, series: [{ name: 's', values }] }, 'bar').trimmed).toBeNull();
  });
});

describe('templates on the initiative deck routes', () => {
  it('lists templates with previews, reads one, and serves the layout gallery to any signed-in reader', async () => {
    const app = as('member');
    const list = await request(app).get(`${BASE}/deck-templates`);
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t: { id: string }) => t.id)).toEqual(['status-update', 'proposal', 'review', 'interview-debrief', 'run-report', 'quarterly-business-review', 'project-kickoff', 'customer-story']);
    expect(list.body.templates[0]).toMatchObject({ title: 'Status update', audience: expect.any(String), style: 'corporate', slideCount: 6 });
    expect(list.body.templates[0].preview).toHaveLength(3);
    const one = await request(app).get(`${BASE}/deck-templates/proposal`);
    expect(one.body.spec.theme).toEqual({ ref: 'orgiq-bold' });
    expect((await request(app).get(`${BASE}/deck-templates/nope`)).status).toBe(404);
    const layouts = await request(app).get(`${BASE}/deck-layouts`);
    expect(layouts.body.layouts).toHaveLength(23);
    expect(layouts.body.layouts.find((l: { layout: string }) => l.layout === 'timeline')).toMatchObject({ useFor: expect.any(String), example: { templateId: 'status-update' } });
    const other = appAs({ role: 'sme' as Session['role'], tenant: 'assessment', sub: 'u-sme' });
    expect((await request(other).get(`${BASE}/deck-templates`)).status).toBe(403);
  });

  it('creates a deck from a template under the build rule; it saves with its example sources and takes operations', async () => {
    const body = { templateId: 'status-update', title: 'Auth migration: status' };
    expect((await request(as('member')).post(`${BASE}/projects/${PID}`).send(body)).status).toBe(403);
    const off = appAs({ role: 'sme' as Session['role'], tenant: 'orgiq', sub: 'u-off' });
    expect((await request(off).post(`${BASE}/projects/${PID}`).send(body)).status).toBe(403);
    expect((await request(as('sme')).post(`${BASE}/projects/${PID}`).send({ templateId: 'nope' })).status).toBe(400);
    const app = as('sme');
    const made = await request(app).post(`${BASE}/projects/${PID}`).send(body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ templateId: 'status-update', revision: { producedBy: 'template:status-update' } });
    expect(made.body.exampleSourceSlideIds).toHaveLength(6);
    const spec = await specOf(app, made.body.deckId, made.body.revisionId);
    expect(spec).toMatchObject({ title: 'Auth migration: status', theme: { ref: 'orgiq-corporate' } });
    // The save rule is the format's: a placeholder source satisfies it, so the save succeeds; the preview names each slide.
    const preview = await request(app).post(`${BASE}/${made.body.deckId}/preview`).send({ spec });
    expect(preview.body.warnings.filter((w: string) => w.includes("the template's example source"))).toHaveLength(6);
    const saved = await request(app).post(`${BASE}/${made.body.deckId}/revisions`).send({ spec, baseRevisionId: made.body.revisionId });
    expect(saved.status).toBe(201);
    const themed = await ops(app, made.body.deckId, saved.body.id, [{ op: 'set_theme', theme: 'engineering' }]);
    expect(themed.status).toBe(201);
    expect(themed.body.exampleSourceSlideIds).toHaveLength(6);
    // A theme change keeps the template's style.
    expect((await specOf(app, made.body.deckId, themed.body.revision.id)).theme).toEqual({ ref: 'engineering-corporate' });
  });
});
