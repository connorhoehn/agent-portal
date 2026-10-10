import { openAs } from './realSession';
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import type { StoredDocumentProposal } from '../src/pages/assessment/knowledge/documentProposalClient.ts';

// Slice 9 of docs/agentic-flows-migration.md: per-suggestion accept/reject of an
// agent's stored edit. Login, source documents and session capabilities use the
// real offline middleware; only the proposal API is stubbed (and the canonical
// canvas is unavailable), so these checks cover the review UI, what is sent to
// the proposal routes, and what a reader may do. They never claim a canvas
// insertion happened: the Apply path is covered by the jest/node suites and the
// existing document-proposals contract.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const SOURCE = 'rule:scoring-guardrails.md';
const DOCUMENT = '11111111-1111-4111-8111-111111111111';
const DOC_URL = `/assessment/rules?doc=${encodeURIComponent(SOURCE)}&tab=editor`;
const BLOCKS = ['## Recipe Format', '- Ingredients\n- Instructions', 'A closing paragraph.'];
const CONTENT = BLOCKS.join('\n\n');
const PROPOSAL: StoredDocumentProposal = {
  id: 'edit-suggestions-1', documentId: DOCUMENT, sourceId: SOURCE, kind: 'insert', anchor: 'cursor', cursor: 1, originalText: '',
  instruction: 'Add a recipe section', content: { text: CONTENT }, summary: 'Adds a recipe section', status: 'ready', version: 1,
  createdBy: 'u-farah', decidedBy: null, createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z',
};
type Write = { path: string; body: Record<string, unknown> };
interface State { proposal: StoredDocumentProposal; writes: Write[] }
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

async function stubProposals(context: BrowserContext, state: State, actor: string, canEdit: boolean) {
  await context.route(url => url.pathname === '/api/assessment/knowledge/canvas' || url.pathname.startsWith('/api/assessment/knowledge/doc/workflows'),
    route => json(route, 503, { error: 'Canonical document services are unavailable for this browser contract check.' }));
  await context.route(url => url.pathname.startsWith('/api/assessment/knowledge/doc/proposals'), async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET') {
      if (url.pathname === '/api/assessment/knowledge/doc/proposals') { await json(route, 200, { documentId: DOCUMENT, proposals: [state.proposal], canEdit }); return; }
      await json(route, 200, { documentId: DOCUMENT, proposal: state.proposal, canEdit }); return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push({ path: url.pathname.split('/').pop()!, body });
    if (!canEdit) { await json(route, 403, { error: 'Document editing permission required' }); return; }
    const p = state.proposal;
    const stamp = '2026-10-06T12:05:00.000Z';
    if (url.pathname.endsWith('/revision')) {
      if (body.version !== p.version || p.status !== 'ready') { await json(route, 409, { error: 'The proposed edit changed. Reload it before revising.' }); return; }
      state.proposal = { ...p, content: body.content as { text: string }, instruction: String(body.instruction), version: p.version + 1, decidedBy: actor, updatedAt: stamp };
      await json(route, 200, { documentId: DOCUMENT, proposal: state.proposal, replayed: false }); return;
    }
    const action = String(body.action);
    const next = { claim: ['ready', 'applying'], release: ['applying', 'ready'], discard: ['ready', 'discarded'], complete: ['applying', 'applied'] }[action];
    if (!next || p.status !== next[0] || body.version !== p.version) { await json(route, 409, { error: 'The proposed edit changed. Reload it before deciding.' }); return; }
    state.proposal = { ...p, status: next[1] as StoredDocumentProposal['status'], version: p.version + 1, decidedBy: action === 'release' ? null : actor, updatedAt: stamp };
    await json(route, 200, { documentId: DOCUMENT, proposal: state.proposal });
  });
}

async function open(browser: import('@playwright/test').Browser, baseURL: string | undefined, userId: string, canEdit: boolean, role?: string) {
  const state: State = { proposal: structuredClone(PROPOSAL), writes: [] };
  const { context, page, errors } = await openAs(browser, userId, {
    baseURL, viewport: { width: 1440, height: 900 }, role, url: DOC_URL,
    prepare: context => stubProposals(context, state, userId, canEdit),
  });
  await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
  return { context, page, state, errors };
}
const cards = (page: Page) => page.getByTestId('document-suggestion');

test('an editor reviews each block, and a partial accept narrows the stored draft before the ordinary Apply claim', async ({ browser, baseURL }) => {
  const { context, page, state, errors } = await open(browser, baseURL, 'u-farah', true, 'lead-assessor');
  try {
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByTestId('document-suggestions-count')).toBeVisible();
    // Reject the list block, accept the other two: nothing is sent until every block has a verdict.
    await cards(page).nth(1).getByTestId('document-suggestion-card-reject').click();
    await expect(cards(page).nth(1)).toHaveAttribute('data-mark', 'reject');
    await expect(cards(page).nth(1).getByTestId('document-suggestion-mark')).toHaveText('Will be removed');
    await cards(page).nth(0).getByTestId('document-suggestion-card-accept').click();
    await expect(page.getByTestId('document-suggestion-pending')).toContainText('1 of 3 still to decide');
    expect(state.writes).toEqual([]);
    await cards(page).nth(2).getByTestId('document-suggestion-card-accept').click();
    // The SAME draft is narrowed (revision CAS, no actor field), then claimed. No canvas is open here,
    // so the insertion preflight refuses and the claim is released: the narrowed draft stays reviewable.
    await expect.poll(() => state.writes.map(write => write.path)).toEqual(['revision', 'decision', 'decision']);
    expect(state.writes[0]!.body).toEqual({ version: 1, instruction: PROPOSAL.instruction, content: { text: `${BLOCKS[0]}\n\n${BLOCKS[2]}` }, summary: PROPOSAL.summary });
    expect(state.writes.slice(1).map(write => write.body.action)).toEqual(['claim', 'release']);
    expect(JSON.stringify(state.writes)).not.toContain('Ingredients');
    await expect(cards(page)).toHaveCount(2);
    await expect(page.getByText('Open the connected, editable document before applying this edit.').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Reject all discards the draft without any revision and removes every suggestion', async ({ browser, baseURL }) => {
  const { context, page, state } = await open(browser, baseURL, 'u-farah', true, 'lead-assessor');
  try {
    await expect(cards(page)).toHaveCount(3);
    await page.getByTestId('document-suggestions-reject-all').click();
    await expect.poll(() => state.writes.map(write => write.body.action)).toEqual(['discard']);
    expect(state.writes.map(write => write.path)).toEqual(['decision']);
    expect(state.proposal.status).toBe('discarded');
    expect(state.proposal.content.text).toBe(CONTENT);
    await expect(cards(page)).toHaveCount(0);
  } finally { await context.close(); }
});

test('rejecting each block one at a time discards once the last verdict is in', async ({ browser, baseURL }) => {
  const { context, page, state } = await open(browser, baseURL, 'u-farah', true, 'lead-assessor');
  try {
    for (let i = 0; i < 3; i += 1) await cards(page).nth(i).getByTestId('document-suggestion-card-reject').click();
    await expect.poll(() => state.writes.map(write => write.body.action)).toEqual(['discard']);
    await expect(cards(page)).toHaveCount(0);
  } finally { await context.close(); }
});

test('a reader sees every suggestion but no accept, reject or bulk controls, and sends nothing', async ({ browser, baseURL }) => {
  const { context, page, state } = await open(browser, baseURL, 'u-asha', false, 'assessor');
  try {
    await expect(cards(page)).toHaveCount(3);
    await expect(cards(page).nth(1)).toContainText('Ingredients');
    await expect(page.getByTestId('document-suggestion-card-accept')).toHaveCount(0);
    await expect(page.getByTestId('document-suggestion-card-reject')).toHaveCount(0);
    await expect(page.getByTestId('document-suggestions-accept-all')).toHaveCount(0);
    await expect(page.getByTestId('document-suggestions-reject-all')).toHaveCount(0);
    expect(state.writes).toEqual([]);
  } finally { await context.close(); }
});
