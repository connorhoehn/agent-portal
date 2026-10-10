import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { openAs } from './realSession';
import type { StoredDocumentProposal } from '../src/pages/assessment/knowledge/documentProposalClient.ts';

// Browser contract checks for persisted proposal UX. Login, source documents,
// the explorer and session capabilities use the real offline middleware. Only
// proposal API responses and canonical-service unavailability are intercepted.
// Revision happy paths use the real offline drafter; failure/cancellation
// paths explicitly substitute AG-UI responses rather than a canonical editor.
// These tests exercise recovery/decisions in the reader fallback; they never
// invent a successful canonical document save or claim to validate Apply.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const SOURCE = 'rule:scoring-guardrails.md';
const DOCUMENT = '11111111-1111-4111-8111-111111111111';
const OTHER_SOURCE = 'rule:what-counts-as-evidence.md';
const OTHER_DOCUMENT = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_URL = `/assessment/rules?doc=${encodeURIComponent(SOURCE)}`;
const CANONICAL_UNAVAILABLE = 'Canonical document services are unavailable for this browser contract check.';
const DECISION_UNAVAILABLE = 'The proposed edit decision could not be saved. Retry this decision.';
const LINK_UNAVAILABLE = 'The linked proposed edit could not be loaded. Retry this lookup.';
const REVISION_UNAVAILABLE = 'The revised proposed edit could not be saved. Retry saving this revision.';
const REVISION_STREAM_ERROR = 'The drafter could not revise this proposed edit.';
const REVISION_FEEDBACK = 'Make the proposed edit shorter and name the evidence owner';
const INITIAL_PROPOSAL: StoredDocumentProposal = {
  id: 'edit-browser-recovered', documentId: DOCUMENT, sourceId: SOURCE,
  kind: 'insert', anchor: 'cursor', cursor: 1, originalText: '',
  instruction: 'Clarify what counts as independent corroboration',
  content: { text: 'Browser contract proposal: cite independent observed evidence before raising a verified level.' },
  summary: 'Clarify the corroboration rule', status: 'ready', version: 1,
  createdBy: 'u-farah', decidedBy: null,
  createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
};
const LINKED_DOCUMENT_URL = `${DOCUMENT_URL}&proposal=${encodeURIComponent(INITIAL_PROPOSAL.id)}&tab=editor`;
type DecisionRequest = { actor: string; action: string; version: number };
type RevisionRequest = { version: number; instruction: string; content: { text: string }; summary?: string };
interface ProposalResponses {
  proposal: StoredDocumentProposal;
  baseProposals?: StoredDocumentProposal[];
  extraProposals?: Record<string, StoredDocumentProposal>;
  reads: number;
  listReads: string[];
  exactReads: Array<{ proposalId: string; sourceId: string }>;
  exactUnavailable: boolean;
  exactMissing?: boolean;
  deferGet?: (route: Route, status: number, body: unknown) => Promise<void>;
  writes: Array<{ path: string; body: unknown }>;
  failedDiscards: number;
  decisions: DecisionRequest[];
  revisions: RevisionRequest[];
  failedRevisions?: number;
  lostRevisionResponses?: number;
  revisionConflict?: StoredDocumentProposal;
}
function responses(): ProposalResponses {
  return { proposal: structuredClone(INITIAL_PROPOSAL), reads: 0, listReads: [], exactReads: [], exactUnavailable: false, writes: [], failedDiscards: 0, decisions: [], revisions: [] };
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({
  status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});
async function proposalResponses(context: BrowserContext, state: ProposalResponses, actor: string, canEdit: boolean) {
  await context.route(url => url.pathname === '/api/assessment/knowledge/canvas' || url.pathname.startsWith('/api/assessment/knowledge/doc/workflows'),
    route => json(route, 503, { error: CANONICAL_UNAVAILABLE }));
  await context.route(url => url.pathname === '/api/assessment/knowledge/doc/proposals' || url.pathname.startsWith('/api/assessment/knowledge/doc/proposals/'), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const sourceId = url.searchParams.get('id');
    expect([SOURCE, OTHER_SOURCE], 'proposal requests name a genuine source document').toContain(sourceId);
    if (request.method() === 'POST') state.writes.push({ path: url.pathname, body: request.postDataJSON() });
    if (request.method() === 'GET' && url.pathname === '/api/assessment/knowledge/doc/proposals') {
      state.reads += 1; state.listReads.push(sourceId!);
      const body = sourceId === OTHER_SOURCE ? { documentId: OTHER_DOCUMENT, proposals: [], canEdit }
        : { documentId: DOCUMENT, proposals: state.baseProposals ?? [state.proposal], canEdit };
      if (state.deferGet) await state.deferGet(route, 200, structuredClone(body));
      else await json(route, 200, body);
      return;
    }
    const exactPrefix = '/api/assessment/knowledge/doc/proposals/';
    if (request.method() === 'GET' && url.pathname.startsWith(exactPrefix)) {
      expect(sourceId, 'a selected proposal remains bound to its source document').toBe(SOURCE);
      const proposalId = decodeURIComponent(url.pathname.slice(exactPrefix.length));
      const proposal = proposalId === state.proposal.id ? state.proposal : state.extraProposals?.[proposalId];
      state.exactReads.push({ proposalId, sourceId: sourceId! });
      const status = state.exactMissing || !proposal ? 404 : state.exactUnavailable ? 503 : 200;
      const body = status === 404 ? { error: 'Proposed edit not found' } : status === 503
        ? { error: LINK_UNAVAILABLE } : { documentId: DOCUMENT, proposal, canEdit };
      if (state.deferGet) await state.deferGet(route, status, structuredClone(body));
      else await json(route, status, body);
      return;
    }
    if (request.method() === 'POST' && url.pathname === `/api/assessment/knowledge/doc/proposals/${INITIAL_PROPOSAL.id}/decision`) {
      const body = request.postDataJSON() as { action: string; version: number };
      expect(Object.keys(body).sort(), 'the browser sends no actor or document authority').toEqual(['action', 'version']);
      state.decisions.push({ actor, ...body });
      if (!canEdit) { await json(route, 403, { error: 'Document editing permission required' }); return; }
      if (body.action !== 'discard') { await json(route, 400, { error: 'This recovery test does not simulate applying canonical content' }); return; }
      if (state.failedDiscards > 0) {
        state.failedDiscards -= 1;
        await json(route, 503, { error: DECISION_UNAVAILABLE });
        return;
      }
      if (state.proposal.status !== 'ready' || body.version !== state.proposal.version) {
        await json(route, 409, { error: 'The proposed edit changed. Reload it before deciding.' });
        return;
      }
      state.proposal = { ...state.proposal, status: 'discarded', version: state.proposal.version + 1, decidedBy: actor, updatedAt: '2026-10-01T12:01:00.000Z' };
      await json(route, 200, { documentId: DOCUMENT, proposal: state.proposal });
      return;
    }
    if (request.method() === 'POST' && url.pathname === `/api/assessment/knowledge/doc/proposals/${INITIAL_PROPOSAL.id}/revision`) {
      expect(sourceId, 'a revision is bound to the original source').toBe(SOURCE);
      const body = request.postDataJSON() as RevisionRequest;
      expect(Object.keys(body).filter(key => key !== 'summary').sort(), 'revision input conveys no actor, target, or lifecycle authority')
        .toEqual(['content', 'instruction', 'version']);
      expect(Object.keys(body.content)).toEqual(['text']);
      state.revisions.push(structuredClone(body));
      if (!canEdit) { await json(route, 403, { error: 'Document editing permission required' }); return; }
      if ((state.failedRevisions ?? 0) > 0) {
        state.failedRevisions! -= 1;
        await json(route, 503, { error: REVISION_UNAVAILABLE }); return;
      }
      if (state.proposal.status === 'ready' && state.proposal.version === body.version + 1 && state.proposal.decidedBy === actor
        && state.proposal.instruction === body.instruction && state.proposal.content.text === body.content.text && state.proposal.summary === body.summary) {
        await json(route, 200, { documentId: DOCUMENT, proposal: state.proposal, replayed: true }); return;
      }
      if (state.revisionConflict) {
        state.proposal = structuredClone(state.revisionConflict);
        state.revisionConflict = undefined;
      }
      if (state.proposal.status !== 'ready' || body.version !== state.proposal.version) {
        await json(route, 409, { error: 'The proposed edit changed. Reload it before revising.' }); return;
      }
      state.proposal = { ...state.proposal, content: structuredClone(body.content), instruction: body.instruction,
        version: state.proposal.version + 1, decidedBy: actor,
        updatedAt: '2026-10-01T12:04:00.000Z' };
      if (body.summary === undefined) delete state.proposal.summary; else state.proposal.summary = body.summary;
      if ((state.lostRevisionResponses ?? 0) > 0) {
        state.lostRevisionResponses! -= 1;
        await json(route, 503, { error: REVISION_UNAVAILABLE }); return;
      }
      await json(route, 200, { documentId: DOCUMENT, proposal: state.proposal, replayed: false }); return;
    }
    await json(route, 400, { error: 'Unexpected proposal request in the browser recovery contract' });
  });
}
async function person(browser: Browser, baseURL: string | undefined, state: ProposalResponses, userId: string, canEdit: boolean, role?: string, documentUrl = DOCUMENT_URL,
  prepare?: (context: BrowserContext) => Promise<void>) {
  const { context, page, errors } = await openAs(browser, userId, {
    baseURL, viewport: { width: 1440, height: 900 }, expectTenant: 'assessment', ...(role ? { role } : {}),
    prepare: async (c) => { await proposalResponses(c, state, userId, canEdit); await prepare?.(c); },
  });
  try {
    await page.goto(documentUrl);
    await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(CANONICAL_UNAVAILABLE, { exact: false }).first()).toBeVisible();
    await expect(page.locator('[data-testid="document-canvas-slot"] .ProseMirror')).toHaveCount(0);
    return { context, page, errors };
  } catch (error) { await context.close(); throw error; }
}
// The item itself carries the id; this locator also asserts there is one strip
// in the shared shell slot, rather than a second strip in the composer.
const recovered = (page: Page, id = INITIAL_PROPOSAL.id) => page.getByTestId('document-shell-proposal')
  .locator(`[data-testid="document-agent-edit-item"][data-proposal-id="${id}"]`);
const settlePresentation = (page: Page) => page.evaluate(() => new Promise<void>(resolve => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
}));
interface DrafterInvocation {
  message: string;
  payload: {
    mode: string; instruction: string;
    document: { id: string; title: string; text: string; truncated: boolean; selection: { from: number; to: number; text: string } | null; cursor: number };
    revision: { id: string; version: number; instruction: string; content: { text: string } };
  };
}
const INVOKE_PATH = '/api/agents/orgiq-assessment-drafter/invoke';
async function captureDrafter(context: BrowserContext, invocations: DrafterInvocation[], behavior?: { error?: string; wait?: Promise<void>; completed?: () => void }) {
  await context.route(url => url.pathname === INVOKE_PATH, async route => {
    invocations.push(route.request().postDataJSON() as DrafterInvocation);
    if (!behavior) { await route.continue(); return; }
    if (behavior.wait) await behavior.wait;
    const events = behavior.error
      ? [{ type: 'RUN_STARTED', threadId: 'revision-contract', runId: 'revision-failure' }, { type: 'RUN_ERROR', message: behavior.error }]
      : [
        { type: 'RUN_STARTED', threadId: 'revision-contract', runId: 'revision-cancelled' },
        { type: 'TEXT_MESSAGE_START', messageId: 'revision-answer', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'revision-answer', delta: JSON.stringify({ content: 'A cancelled late revision must never be saved.', summary: 'Cancelled late response' }) },
        { type: 'TEXT_MESSAGE_END', messageId: 'revision-answer' },
        { type: 'RUN_FINISHED', threadId: 'revision-contract', runId: 'revision-cancelled' },
      ];
    try {
      await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
    } catch (error) {
      // Stop aborts native fetch while this explicit delayed response is held.
      if (!behavior.wait) throw error;
    } finally { behavior.completed?.(); }
  });
}
async function askForRevision(page: Page, instruction = REVISION_FEEDBACK) {
  const row = recovered(page);
  await row.getByRole('button', { name: 'Revise…', exact: true }).click();
  const input = row.getByRole('textbox', { name: 'Revision instruction' });
  await expect(input).toBeFocused();
  await input.fill(instruction);
  await row.getByRole('button', { name: 'Send', exact: true }).click();
}
function expectOriginalRevisionContext(invocation: DrafterInvocation, original: StoredDocumentProposal) {
  expect(invocation.message).toBe(REVISION_FEEDBACK);
  expect(invocation.payload.mode).toBe('suggest-confluence-content');
  expect(invocation.payload.instruction).toContain(REVISION_FEEDBACK);
  expect(invocation.payload.document).toMatchObject({ id: SOURCE, cursor: original.cursor });
  expect(invocation.payload.document.text).toContain('A self-rating with no independent corroboration');
  expect(invocation.payload.revision).toEqual({ id: original.id, version: original.version,
    instruction: original.instruction, content: original.content });
  expect(invocation.payload.document.selection).toEqual(original.kind === 'replace' && original.anchor !== 'cursor'
    ? { ...original.anchor, text: original.originalText } : null);
}

test('a stored proposal recovers after reload and in another authorized browser, with a shared Discard decision', async ({ browser, baseURL }, testInfo) => {
  const state = responses();
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor');
  let jonas: Awaited<ReturnType<typeof person>> | undefined;
  try {
    await expect(recovered(farah.page)).toBeVisible();
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(INITIAL_PROPOSAL.content.text);
    await expect(farah.page.getByTestId('document-agent-edit')).toHaveCount(1);
    await farah.page.reload();
    await expect(recovered(farah.page)).toContainText(INITIAL_PROPOSAL.content.text);
    expect(state.reads).toBeGreaterThanOrEqual(2);
    jonas = await person(browser, baseURL, state, 'u-jonas', true, 'lead-assessor');
    await expect(recovered(jonas.page)).toContainText(INITIAL_PROPOSAL.content.text);
    await jonas.page.screenshot({ path: testInfo.outputPath('recovered-proposal.png'), fullPage: true });
    await recovered(jonas.page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(recovered(jonas.page)).toHaveCount(0);
    // No server SSE is fabricated by the response double. The real hook's
    // focus recovery fetch observes the same persisted decision in the peer.
    await farah.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(recovered(farah.page)).toHaveCount(0);
    await farah.page.reload();
    await expect(recovered(farah.page)).toHaveCount(0);
    expect(state.proposal).toMatchObject({ status: 'discarded', version: 2, decidedBy: 'u-jonas' });
    expect(state.decisions).toEqual([{ actor: 'u-jonas', action: 'discard', version: 1 }]);
    expect(farah.errors).toEqual([]); expect(jonas.errors).toEqual([]);
  } finally { await farah.context.close(); await jonas?.context.close(); }
});

test('a failed Discard preserves the ready proposal and explanation, and a retry remains discarded after reload', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); state.failedDiscards = 1;
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor');
  try {
    await expect(recovered(farah.page)).toBeVisible();
    await recovered(farah.page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(farah.page.getByTestId('page-composer-error')).toContainText(DECISION_UNAVAILABLE);
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(INITIAL_PROPOSAL.content.text);
    expect(state.proposal).toMatchObject({ status: 'ready', version: 1 });
    await farah.page.screenshot({ path: testInfo.outputPath('discard-failure.png'), fullPage: true });
    await recovered(farah.page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(recovered(farah.page)).toHaveCount(0);
    await expect(farah.page.getByTestId('page-composer-error')).toHaveCount(0);
    await farah.page.reload();
    await expect(recovered(farah.page)).toHaveCount(0);
    expect(state.decisions).toEqual([
      { actor: 'u-farah', action: 'discard', version: 1 },
      { actor: 'u-farah', action: 'discard', version: 1 },
    ]);
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

test('an authorized reader recovers the pending-edit notice without Apply or Discard controls', async ({ browser, baseURL }, testInfo) => {
  const state = responses();
  const asha = await person(browser, baseURL, state, 'u-asha', false, 'assessor');
  try {
    const slot = asha.page.getByTestId('document-shell-proposal');
    await expect(slot).toContainText('1 proposed edit awaits an editor. Your current access is read-only.');
    await expect(slot.getByRole('button', { name: /^(Apply|Discard)$/ })).toHaveCount(0);
    await expect(asha.page.getByTestId('document-agent-edit')).toHaveCount(0);
    await asha.page.reload();
    await expect(slot).toContainText('Your current access is read-only.');
    await expect(slot.getByRole('button', { name: /^(Apply|Discard)$/ })).toHaveCount(0);
    expect(state.decisions).toEqual([]);
    expect(state.proposal.status).toBe('ready');
    await asha.page.screenshot({ path: testInfo.outputPath('reader-proposal-notice.png'), fullPage: true });
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('a notification deep link fetches and focuses a ready proposal beyond the base 100 without deciding it', async ({ browser, baseURL }, testInfo) => {
  const state = responses();
  state.baseProposals = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(INITIAL_PROPOSAL), id: `edit-browser-newer-${index}`,
    summary: `Newer proposed edit ${index}`, content: { text: `Newer proposal preview ${index}` },
    createdAt: '2026-10-01T12:02:00.000Z', updatedAt: '2026-10-01T12:02:00.000Z',
  }));
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL);
  try {
    expect(state.baseProposals).toHaveLength(100);
    expect(state.baseProposals.some(proposal => proposal.id === INITIAL_PROPOSAL.id)).toBe(false);
    const target = recovered(farah.page);
    await expect(target).toHaveAttribute('data-status', 'ready');
    await expect(target).toContainText(INITIAL_PROPOSAL.content.text);
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    expect(state.reads).toBeGreaterThanOrEqual(1);
    expect(state.exactReads).toContainEqual({ proposalId: INITIAL_PROPOSAL.id, sourceId: SOURCE });
    expect(state.writes).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(state.proposal).toMatchObject({ status: 'ready', version: 1 });
    await expect(farah.page).toHaveURL(LINKED_DOCUMENT_URL);
    await farah.page.screenshot({ path: testInfo.outputPath('linked-ready-proposal.png'), fullPage: true });
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

for (const status of ['applied', 'discarded'] as const) {
  test(`${status === 'applied' ? 'An' : 'A'} ${status} notification target keeps its status and preview readable without decision actions`, async ({ browser, baseURL }, testInfo) => {
    const state = responses();
    state.proposal = { ...state.proposal, status, version: 3, decidedBy: 'u-jonas', updatedAt: '2026-10-01T12:03:00.000Z' };
    const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL);
    try {
      const preview = farah.page.getByTestId('document-linked-proposal');
      await expect(preview).toBeVisible();
      await expect(preview).toContainText(INITIAL_PROPOSAL.content.text);
      await expect(farah.page.getByTestId('document-proposal-link-notice')).toContainText(new RegExp(status, 'i'));
      await expect(farah.page.getByTestId('document-shell-proposal').getByRole('button', { name: /^(Apply|Discard)$/ })).toHaveCount(0);
      await expect(farah.page.getByTestId('document-agent-edit')).toHaveCount(0);
      expect(state.exactReads).toContainEqual({ proposalId: INITIAL_PROPOSAL.id, sourceId: SOURCE });
      expect(state.writes).toEqual([]);
      expect(state.proposal).toMatchObject({ status, version: 3 });
      await farah.page.screenshot({ path: testInfo.outputPath(`linked-${status}-proposal.png`), fullPage: true });
      expect(farah.errors).toEqual([]);
    } finally { await farah.context.close(); }
  });
}

test('an authorized read-only notification target shows the exact proposal preview without Apply or Discard', async ({ browser, baseURL }, testInfo) => {
  const state = responses();
  const asha = await person(browser, baseURL, state, 'u-asha', false, 'assessor', LINKED_DOCUMENT_URL);
  try {
    const preview = asha.page.getByTestId('document-linked-proposal');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(INITIAL_PROPOSAL.content.text);
    await expect(asha.page.getByTestId('document-shell-proposal')).toContainText(/read-only/i);
    await expect(asha.page.getByTestId('document-shell-proposal').getByRole('button', { name: /^(Apply|Discard)$/ })).toHaveCount(0);
    await expect(asha.page.getByTestId('document-agent-edit')).toHaveCount(0);
    expect(state.exactReads).toContainEqual({ proposalId: INITIAL_PROPOSAL.id, sourceId: SOURCE });
    expect(state.writes).toEqual([]);
    expect(state.proposal).toMatchObject({ status: 'ready', version: 1 });
    await asha.page.screenshot({ path: testInfo.outputPath('linked-reader-proposal.png'), fullPage: true });
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

test('an exact proposal lookup failure stays visible and Retry recovers the requested proposal without deciding it', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); state.exactUnavailable = true;
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL);
  try {
    const notice = farah.page.getByTestId('document-proposal-link-notice');
    await expect(notice).toContainText(LINK_UNAVAILABLE);
    const failedReads = state.exactReads.length;
    expect(failedReads).toBeGreaterThanOrEqual(1);
    expect(state.writes).toEqual([]);
    await farah.page.screenshot({ path: testInfo.outputPath('linked-lookup-failure.png'), fullPage: true });
    state.exactUnavailable = false;
    await notice.getByRole('button', { name: /^Retry\b/ }).click();
    await expect(notice).not.toContainText(LINK_UNAVAILABLE);
    await expect(recovered(farah.page)).toContainText(INITIAL_PROPOSAL.content.text);
    await expect(recovered(farah.page)).toBeFocused();
    expect(state.exactReads.length).toBeGreaterThan(failedReads);
    expect(state.exactReads.every(read => read.proposalId === INITIAL_PROPOSAL.id && read.sourceId === SOURCE)).toBe(true);
    expect(state.writes).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

test('a missing notification target keeps the genuine source readable and unrelated ready proposals actionable', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); state.exactMissing = true;
  const unrelated = { ...structuredClone(INITIAL_PROPOSAL), id: 'edit-browser-unrelated', content: { text: 'An unrelated ready proposed edit remains available.' } };
  state.baseProposals = [unrelated];
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL);
  try {
    await expect(farah.page.getByTestId('document-proposal-link-notice')).toContainText('The linked proposed edit is no longer available for this document.');
    await expect(farah.page.getByTestId('document-surface').locator('.doc-markdown')).toContainText('A self-rating with no independent corroboration');
    await expect(farah.page.getByTestId('document-linked-proposal')).toHaveCount(0);
    await expect(recovered(farah.page)).toHaveCount(0);
    const available = recovered(farah.page, unrelated.id);
    await expect(available).toContainText(unrelated.content.text);
    for (const action of ['Apply', 'Discard']) await expect(available.getByRole('button', { name: action, exact: true })).toBeVisible();
    expect(state.exactReads).toContainEqual({ proposalId: INITIAL_PROPOSAL.id, sourceId: SOURCE });
    expect(state.writes).toEqual([]);
    await farah.page.screenshot({ path: testInfo.outputPath('linked-missing-proposal.png'), fullPage: true });
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

test('a late exact response cannot replace or focus the proposal selected by a newer navigation', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); state.baseProposals = [];
  const next = { ...structuredClone(INITIAL_PROPOSAL), id: 'edit-browser-new-target', content: { text: 'The newer notification target must keep focus and its own preview.' } };
  state.extraProposals = { [next.id]: next };
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  state.deferGet = async (route, status, body) => {
    if (new URL(route.request().url()).pathname.endsWith(`/${INITIAL_PROPOSAL.id}`)) { delayed = true; await held; }
    await json(route, status, body);
  };
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL, async context => {
    // Simulate a transport whose old request cannot be cancelled. This one
    // fetch still receives its explicit API response after navigation, so
    // the stale-result guards, rather than native cancellation alone, must
    // preserve the newer target. Other requests use native fetch unchanged.
    await context.addInitScript(({ path }) => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href, location.href);
        return fetch(input, url.pathname === path ? { ...init, signal: undefined } : init);
      };
    }, { path: `/api/assessment/knowledge/doc/proposals/${INITIAL_PROPOSAL.id}` });
  });
  try {
    await expect.poll(() => delayed).toBe(true);
    const nextUrl = `${DOCUMENT_URL}&proposal=${encodeURIComponent(next.id)}&tab=editor`;
    await farah.page.evaluate(url => {
      const state = { ...history.state, key: crypto.randomUUID(), idx: (history.state?.idx ?? 0) + 1 };
      history.pushState(state, '', url);
      dispatchEvent(new PopStateEvent('popstate', { state }));
    }, nextUrl);
    const target = recovered(farah.page, next.id);
    await expect(target).toContainText(next.content.text);
    await expect(target).toBeFocused();
    const late = farah.page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/${INITIAL_PROPOSAL.id}`));
    release();
    const response = await late; expect(response.status()).toBe(200); await response.finished();
    await settlePresentation(farah.page);
    await expect(target).toContainText(next.content.text);
    await expect(target).toBeFocused();
    await expect(recovered(farah.page)).toHaveCount(0);
    await expect(farah.page).toHaveURL(nextUrl);
    expect(state.exactReads).toEqual(expect.arrayContaining([
      { proposalId: INITIAL_PROPOSAL.id, sourceId: SOURCE }, { proposalId: next.id, sourceId: SOURCE },
    ]));
    expect(state.writes).toEqual([]);
    await farah.page.screenshot({ path: testInfo.outputPath('linked-newer-navigation.png'), fullPage: true });
    expect(farah.errors).toEqual([]);
  } finally { release(); await farah.context.close(); }
});

test('selecting another genuine document in the explorer clears the previous proposal parameter', async ({ browser, baseURL }, testInfo) => {
  const state = responses();
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL);
  try {
    await expect(recovered(farah.page)).toBeFocused();
    await farah.page.getByTestId(`document-rail-tree-row-${OTHER_SOURCE}`).click();
    await expect(farah.page).toHaveURL(url => url.searchParams.get('doc') === OTHER_SOURCE && !url.searchParams.has('proposal'));
    await expect(farah.page.getByTestId('document-shell')).toContainText('What Counts as Evidence');
    await expect(farah.page.getByTestId('document-surface').locator('.doc-markdown')).toContainText('For all dimensions, evidence should be concrete and reviewable.');
    await expect(farah.page.getByTestId('document-proposal-link-notice')).toHaveCount(0);
    await expect(recovered(farah.page)).toHaveCount(0);
    await expect.poll(() => state.listReads.includes(OTHER_SOURCE)).toBe(true);
    expect(state.exactReads.every(read => read.sourceId === SOURCE)).toBe(true);
    expect(state.writes).toEqual([]);
    await farah.page.screenshot({ path: testInfo.outputPath('linked-other-document.png'), fullPage: true });
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

test('an older in-flight refresh cannot resurrect a linked proposal after its Discard decision persists', async ({ browser, baseURL }, testInfo) => {
  const state = responses();
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending: string[] = [];
  let completed = 0;
  try {
    await expect(recovered(farah.page)).toBeFocused();
    expect(state.writes).toEqual([]);
    state.deferGet = async (route, status, body) => {
      pending.push(new URL(route.request().url()).pathname);
      await held;
      await json(route, status, body);
      completed += 1;
    };
    await farah.page.evaluate(() => dispatchEvent(new Event('focus')));
    await expect.poll(() => pending.some(path => path === '/api/assessment/knowledge/doc/proposals')
      && pending.some(path => path.endsWith(`/${INITIAL_PROPOSAL.id}`))).toBe(true);
    await recovered(farah.page).getByRole('button', { name: 'Discard', exact: true }).click();
    const preview = farah.page.getByTestId('document-linked-proposal');
    await expect(preview).toHaveAttribute('data-status', 'discarded');
    expect(state.proposal).toMatchObject({ status: 'discarded', version: 2 });
    release();
    await expect.poll(() => completed).toBeGreaterThanOrEqual(2);
    await settlePresentation(farah.page);
    await expect(preview).toHaveAttribute('data-status', 'discarded');
    await expect(preview).toContainText(INITIAL_PROPOSAL.content.text);
    await expect(farah.page.getByTestId('document-proposal-link-notice')).toContainText('discarded');
    await expect(farah.page.getByTestId('document-shell-proposal').getByRole('button', { name: /^(Apply|Discard)$/ })).toHaveCount(0);
    expect(state.decisions).toEqual([{ actor: 'u-farah', action: 'discard', version: 1 }]);
    expect(state.writes).toHaveLength(1);
    await farah.page.screenshot({ path: testInfo.outputPath('linked-discard-refresh-race.png'), fullPage: true });
    expect(farah.errors).toEqual([]);
  } finally { release(); await farah.context.close(); }
});

for (const kind of ['insert', 'replace'] as const) {
  test(`Revise regenerates the ${kind} draft on its original target and the versioned preview survives reload and peer recovery`, async ({ browser, baseURL }, testInfo) => {
    const state = responses();
    if (kind === 'replace') state.proposal = { ...state.proposal, kind, anchor: { from: 7, to: 57 }, cursor: 7,
      originalText: 'A self-rating with no independent corroboration' };
    const original = structuredClone(state.proposal);
    const invocations: DrafterInvocation[] = [];
    const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
      context => captureDrafter(context, invocations));
    let jonas: Awaited<ReturnType<typeof person>> | undefined;
    try {
      await askForRevision(farah.page);
      await expect.poll(() => state.revisions.length).toBe(1);
      await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
      await expect(recovered(farah.page)).toContainText(state.proposal.content.text);
      expect(invocations).toHaveLength(1);
      expectOriginalRevisionContext(invocations[0]!, original);
      expect(state.proposal).toMatchObject({ id: original.id, kind, anchor: original.anchor, originalText: original.originalText,
        cursor: original.cursor, status: 'ready', version: 2, createdBy: original.createdBy, decidedBy: 'u-farah' });
      expect(state.proposal.content.text.trim()).not.toBe('');
      expect(state.proposal.content.text).not.toBe(original.content.text);
      expect(state.revisions[0]).toMatchObject({ version: 1, content: state.proposal.content });
      expect(state.revisions[0]!.instruction).toContain(REVISION_FEEDBACK);
      expect(state.writes.map(write => write.path)).toEqual([`/api/assessment/knowledge/doc/proposals/${original.id}/revision`]);
      expect(state.decisions).toEqual([]);
      await farah.page.screenshot({ path: testInfo.outputPath(`revised-${kind}-proposal.png`), fullPage: true });
      await farah.page.reload();
      await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
      await expect(recovered(farah.page)).toContainText(state.proposal.content.text);
      jonas = await person(browser, baseURL, state, 'u-jonas', true, 'lead-assessor', LINKED_DOCUMENT_URL);
      await expect(recovered(jonas.page)).toContainText(state.proposal.content.text);
      await expect(recovered(jonas.page).getByRole('button', { name: 'Revise…', exact: true })).toBeVisible();
      expect(invocations).toHaveLength(1);
      expect(state.revisions).toHaveLength(1);
      expect(farah.errors).toEqual([]); expect(jonas.errors).toEqual([]);
    } finally { await farah.context.close(); await jonas?.context.close(); }
  });
}

test('a failed revision stream restores the original ready proposal without a metadata write', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); const original = structuredClone(state.proposal); const invocations: DrafterInvocation[] = [];
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
    context => captureDrafter(context, invocations, { error: REVISION_STREAM_ERROR }));
  try {
    await askForRevision(farah.page);
    await expect(farah.page.getByTestId('page-composer-error')).toContainText(REVISION_STREAM_ERROR);
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(original.content.text);
    await expect(recovered(farah.page).getByRole('button', { name: 'Revise…', exact: true })).toBeVisible();
    expect(invocations).toHaveLength(1); expectOriginalRevisionContext(invocations[0]!, original);
    expect(state.proposal).toEqual(original); expect(state.writes).toEqual([]);
    await farah.page.screenshot({ path: testInfo.outputPath('revision-stream-failure.png'), fullPage: true });
    await farah.page.reload();
    await expect(recovered(farah.page)).toContainText(original.content.text);
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

test('Stop restores the original ready draft and a delayed cancelled response cannot save a revision', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); const original = structuredClone(state.proposal); const invocations: DrafterInvocation[] = [];
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let completed = false;
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
    context => captureDrafter(context, invocations, { wait: held, completed: () => { completed = true; } }));
  try {
    await askForRevision(farah.page);
    await expect.poll(() => invocations.length).toBe(1);
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'streaming');
    await farah.page.getByRole('button', { name: /^Stop\b/ }).click();
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(original.content.text);
    release(); await expect.poll(() => completed).toBe(true); await settlePresentation(farah.page);
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(original.content.text);
    expect(state.proposal).toEqual(original); expect(state.writes).toEqual([]);
    await farah.page.screenshot({ path: testInfo.outputPath('revision-cancelled.png'), fullPage: true });
    expect(farah.errors).toEqual([]);
  } finally { release(); await farah.context.close(); }
});

test('a revision save outage keeps the generated candidate for Retry without calling the drafter again', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); state.failedRevisions = 1; const original = structuredClone(state.proposal);
  const invocations: DrafterInvocation[] = [];
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
    context => captureDrafter(context, invocations));
  try {
    await askForRevision(farah.page);
    await expect(farah.page.getByTestId('page-composer-error')).toContainText(REVISION_UNAVAILABLE);
    expect(state.revisions).toHaveLength(1);
    const candidate = structuredClone(state.revisions[0]!);
    expect(candidate.content.text).not.toBe(original.content.text);
    await expect(recovered(farah.page)).toContainText(original.content.text);
    await expect(farah.page.getByTestId('document-unsaved-revision')).toContainText(candidate.content.text);
    expect(state.proposal).toEqual(original);
    const retry = farah.page.getByRole('button', { name: /Retry saving revision/i });
    await expect(retry).toBeVisible();
    await farah.page.screenshot({ path: testInfo.outputPath('revision-save-failure.png'), fullPage: true });
    await retry.click();
    await expect.poll(() => state.revisions.length).toBe(2);
    await expect(farah.page.getByTestId('page-composer-error')).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    await expect(farah.page.getByTestId('document-unsaved-revision')).toHaveCount(0);
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(candidate.content.text);
    expect(state.revisions[1]).toEqual(candidate);
    expect(state.proposal).toMatchObject({ id: original.id, version: 2, content: candidate.content });
    expect(invocations).toHaveLength(1); expect(state.decisions).toEqual([]);
    await farah.page.reload();
    await expect(recovered(farah.page)).toContainText(candidate.content.text);
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

test('Retry replays a stored revision after its first response is lost without advancing the version or invoking again', async ({ browser, baseURL }, testInfo) => {
  const state = responses(); state.lostRevisionResponses = 1; const original = structuredClone(state.proposal);
  const invocations: DrafterInvocation[] = [];
  const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
    context => captureDrafter(context, invocations));
  try {
    await askForRevision(farah.page);
    await expect(farah.page.getByTestId('page-composer-error')).toContainText(REVISION_UNAVAILABLE);
    expect(state.revisions).toHaveLength(1);
    const candidate = structuredClone(state.revisions[0]!);
    const saved = structuredClone(state.proposal);
    expect(saved).toMatchObject({ id: original.id, version: 2, status: 'ready', decidedBy: 'u-farah', content: candidate.content });
    await expect(recovered(farah.page)).toContainText(original.content.text);
    await expect(farah.page.getByTestId('document-unsaved-revision')).toContainText(saved.content.text);
    // The write double has stored v2 but supplied no SSE/focus refresh. Retry
    // must use the same candidate/version and receive the backend's replay.
    await farah.page.getByRole('button', { name: 'Retry saving revision', exact: true }).click();
    await expect.poll(() => state.revisions.length).toBe(2);
    await expect(recovered(farah.page)).toHaveAttribute('data-status', 'ready');
    await expect(recovered(farah.page)).toContainText(saved.content.text);
    await expect(farah.page.getByTestId('document-unsaved-revision')).toHaveCount(0);
    await expect(farah.page.getByTestId('page-composer-error')).toHaveCount(0);
    expect(state.revisions[1]).toEqual(candidate);
    expect(state.proposal).toEqual(saved);
    expect(state.writes).toHaveLength(2); expect(state.decisions).toEqual([]); expect(invocations).toHaveLength(1);
    await farah.page.screenshot({ path: testInfo.outputPath('revision-lost-response-replayed.png'), fullPage: true });
    await farah.page.reload();
    await expect(recovered(farah.page)).toContainText(saved.content.text);
    expect(state.proposal.version).toBe(2); expect(state.revisions).toHaveLength(2);
    expect(farah.errors).toEqual([]);
  } finally { await farah.context.close(); }
});

for (const status of ['ready', 'applying', 'applied', 'discarded'] as const) {
  test(`a revision version conflict refreshes the authoritative ${status} proposal and cannot overwrite it`, async ({ browser, baseURL }, testInfo) => {
    const state = responses(); const original = structuredClone(state.proposal); const invocations: DrafterInvocation[] = [];
    const authority = { ...structuredClone(original), status, version: 4,
      content: { text: `Another editor's authoritative ${status} draft must survive the rejected revision.` },
      summary: `Authoritative ${status} proposal`, decidedBy: status === 'ready' ? null : 'u-jonas', updatedAt: '2026-10-01T12:05:00.000Z' };
    state.revisionConflict = authority;
    const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
      context => captureDrafter(context, invocations));
    try {
      await askForRevision(farah.page);
      await expect.poll(() => state.revisions.length).toBe(1);
      await expect(farah.page.getByTestId('page-composer-error')).toContainText(/changed|conflict/i);
      const row = status === 'applied' || status === 'discarded' ? farah.page.getByTestId('document-linked-proposal') : recovered(farah.page);
      await expect(row).toHaveAttribute('data-status', status);
      await expect(row).toContainText(authority.content.text);
      await expect(farah.page.getByRole('button', { name: /Retry saving revision/i })).toHaveCount(0);
      if (status !== 'ready') await expect(row.getByRole('button', { name: 'Revise…', exact: true })).toHaveCount(0);
      expect(state.proposal).toEqual(authority);
      expect(state.revisions[0]!.version).toBe(1);
      expect(state.writes.map(write => write.path)).toEqual([`/api/assessment/knowledge/doc/proposals/${original.id}/revision`]);
      expect(state.decisions).toEqual([]);
      await farah.page.screenshot({ path: testInfo.outputPath(`revision-${status}-conflict.png`), fullPage: true });
      await farah.page.reload();
      await expect(row).toContainText(authority.content.text);
      expect(state.proposal).toEqual(authority); expect(state.revisions).toHaveLength(1);
      expect(farah.errors).toEqual([]);
    } finally { await farah.context.close(); }
  });
}

test('a read-only linked proposal offers no Revise control and does not invoke the drafter', async ({ browser, baseURL }) => {
  const state = responses(); const invocations: DrafterInvocation[] = [];
  const asha = await person(browser, baseURL, state, 'u-asha', false, 'assessor', LINKED_DOCUMENT_URL,
    context => captureDrafter(context, invocations));
  try {
    await expect(asha.page.getByTestId('document-linked-proposal')).toContainText(INITIAL_PROPOSAL.content.text);
    await expect(asha.page.getByTestId('document-shell-proposal').getByRole('button', { name: 'Revise…', exact: true })).toHaveCount(0);
    expect(invocations).toEqual([]); expect(state.revisions).toEqual([]); expect(state.writes).toEqual([]);
    expect(asha.errors).toEqual([]);
  } finally { await asha.context.close(); }
});

for (const status of ['applied', 'discarded'] as const) {
  test(`a retained ${status} proposal has no Revise action`, async ({ browser, baseURL }) => {
    const state = responses(); state.proposal = { ...state.proposal, status, version: 3, decidedBy: 'u-jonas' };
    const invocations: DrafterInvocation[] = [];
    const farah = await person(browser, baseURL, state, 'u-farah', true, 'lead-assessor', LINKED_DOCUMENT_URL,
      context => captureDrafter(context, invocations));
    try {
      await expect(farah.page.getByTestId('document-linked-proposal')).toHaveAttribute('data-status', status);
      await expect(farah.page.getByTestId('document-shell-proposal').getByRole('button', { name: 'Revise…', exact: true })).toHaveCount(0);
      expect(invocations).toEqual([]); expect(state.revisions).toEqual([]); expect(state.writes).toEqual([]);
      expect(farah.errors).toEqual([]);
    } finally { await farah.context.close(); }
  });
}
