jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
jest.mock('../document-mapping.js', () => ({ documentSourceRevision: () => 'revision', ensureDocumentMapping: jest.fn() }));
jest.mock('../document-workflows.js', () => ({ performDocumentWorkflow: jest.fn() }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/assessment-broker.js', () => ({ assessmentBroker: { publish: jest.fn() } }));

import { config } from '../../config.js';
import { isAllowed } from '../../lib/authz.js';
import { assessmentBroker } from '../../lib/assessment-broker.js';
import type { Session } from '../../lib/session.js';
import { setNotificationSink } from '../../lib/social-notify.js';
import { documentProposalsFixture } from '../../mock/document-proposals.js';
import { clock, freezeClock } from '../../mock/core/clock.js';
import { getUser, type UserInfo } from '../identity.js';
import { getKnowledgeDoc } from '../assessment.js';
import { ensureDocumentMapping } from '../document-mapping.js';
import { performDocumentWorkflow } from '../document-workflows.js';
import { exec } from '../aurora.js';
import { createDocumentProposal, decideDocumentProposal, getDocumentProposal, listDocumentProposals, reviseDocumentProposal } from '../document-proposals.js';
import { parseDocumentProposal, parseDocumentProposalRevision, producerLabel, type DocumentEditProposal, type DocumentProposalInput, type DocumentProposalRevision } from '../../lib/document-proposals.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const sourceId = 'local:guide.md';
const editor: Session = { sub: 'editor', role: 'lead-assessor', tenant: 'assessment', grants: { assessment: ['lead-assessor'] }, epoch: 2, iat: 1 };
const reader: Session = { ...editor, sub: 'reader', role: 'assessor', grants: { assessment: ['assessor'] } };
const input: DocumentProposalInput = { id: 'edit-stable-id', kind: 'insert', anchor: 'cursor', content: { text: 'Proposed paragraph' }, originalText: '', cursor: 1, instruction: 'Clarify the guide', summary: 'A clearer explanation' };
const revision: DocumentProposalRevision = { version: 1, instruction: 'Make the proposed paragraph shorter', content: { text: 'Shorter proposed paragraph' }, summary: 'Shortens the proposal' };
const draft = (overrides: Partial<DocumentEditProposal> = {}): DocumentEditProposal => ({ ...input,
  documentId: DOC, sourceId, status: 'ready', version: 1, createdBy: 'editor', producer: 'Assessment drafter', decidedBy: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
let send: jest.Mock;
const identity = (id: string, grants: Record<string, string[]> = { assessment: [id === 'reader' ? 'assessor' : 'lead-assessor'] }, epoch = 2): UserInfo =>
  ({ id, displayName: id, email: `${id}@example.test`, personId: null, epoch, grants });
beforeEach(() => {
  jest.clearAllMocks(); (config.mock as { aurora: boolean }).aurora = true; documentProposalsFixture.reset();
  jest.mocked(getUser).mockImplementation(async id => identity(id));
  jest.mocked(isAllowed).mockImplementation(async (session, action) => action === 'ViewAssessment' || session.role === 'lead-assessor');
  jest.mocked(getKnowledgeDoc).mockImplementation(async id => ({ id, title: 'Guide', classification: 'internal', markdown: '# Guide', editable: true, path: 'guide.md', updated_at: clock.nowIso() }));
  jest.mocked(ensureDocumentMapping).mockImplementation(async id => ({ tenant_id: 'assessment', source_namespace: 'knowledge', source_id: id,
    document_id: id === sourceId ? DOC : OTHER, source_revision: 'revision', schema_version: 2, migration_state: 'ready', owner_sub: null, published_revision: null }));
  jest.mocked(performDocumentWorkflow).mockImplementation(async (_id, _session, operation) => ({ status: 200, body: operation.kind === 'write-policy'
    ? { documentId: DOC, canWrite: true } : { documentId: DOC, lifecycle: { ownerId: 'owner' } } }));
  send = jest.fn(async () => undefined); setNotificationSink({ notifyUser: send });
});
afterEach(() => setNotificationSink(null));

it('stores one attributed draft, recovers it for another reader, and notifies the canonical owner once', async () => {
  const first = await createDocumentProposal(sourceId, editor, input);
  expect(first).toMatchObject({ documentId: DOC, created: true, proposal: { status: 'ready', version: 1, createdBy: 'editor', producer: 'Assessment drafter', decidedBy: null } });
  const retried = await createDocumentProposal(sourceId, editor, input);
  expect(retried.created).toBe(false);
  const opened = await listDocumentProposals(sourceId, reader);
  expect(opened).toMatchObject({ documentId: DOC, canEdit: false, proposals: [first.proposal] });
  opened.proposals[0]!.content.text = 'browser mutation';
  expect((await listDocumentProposals(sourceId, reader)).proposals[0]!.content.text).toBe(input.content.text);
  await tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('owner', expect.objectContaining({ type: 'approval-requested', payload: expect.objectContaining({ tenant: 'assessment', proposalId: input.id }),
    action: { label: 'Review the proposed edit', href: '/assessment/workspace?doc=local%3Aguide.md&proposal=edit-stable-id' } }));
  expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
  expect(assessmentBroker.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'knowledge.proposal.changed', doc_id: sourceId, status: 'ready', version: 1 }));
  expect(jest.mocked(assessmentBroker.publish).mock.calls[0]![0]).not.toHaveProperty('content');
  expect(getUser).toHaveBeenCalledWith('editor', { authoritative: true });
  expect(getUser).toHaveBeenCalledWith('reader', { authoritative: true });
});
it('refuses id collisions from another author or a changed body', async () => {
  await createDocumentProposal(sourceId, editor, input);
  await expect(createDocumentProposal(sourceId, { ...editor, sub: 'other-editor' }, input)).rejects.toMatchObject({ status: 409 });
  await expect(createDocumentProposal(sourceId, editor, { ...input, content: { text: 'Different' } })).rejects.toMatchObject({ status: 409 });
  expect(documentProposalsFixture.rows()).toHaveLength(1);
});
it('only one concurrent claim succeeds, and only its editor can confirm or release it', async () => {
  await createDocumentProposal(sourceId, editor, input);
  const claims = await Promise.allSettled([decideDocumentProposal(sourceId, editor, input.id, 'claim', 1), decideDocumentProposal(sourceId, reader, input.id, 'claim', 1)]);
  expect(claims[0]).toMatchObject({ status: 'fulfilled', value: { proposal: { status: 'applying', version: 2, decidedBy: 'editor' } } });
  expect(claims[1]).toMatchObject({ status: 'rejected', reason: { status: 403 } });
  await expect(decideDocumentProposal(sourceId, { ...editor, sub: 'other-editor' }, input.id, 'complete', 2)).rejects.toMatchObject({ status: 403 });
  await expect(decideDocumentProposal(sourceId, { ...editor, sub: 'other-editor' }, input.id, 'release', 2)).rejects.toMatchObject({ status: 403 });
  await expect(decideDocumentProposal(sourceId, editor, input.id, 'discard', 2)).rejects.toMatchObject({ status: 409 });
  const released = await decideDocumentProposal(sourceId, editor, input.id, 'release', 2);
  expect(released.proposal).toMatchObject({ status: 'ready', version: 3, decidedBy: null });
  await expect(decideDocumentProposal(sourceId, editor, input.id, 'claim', 1)).rejects.toMatchObject({ status: 409 });
  await decideDocumentProposal(sourceId, editor, input.id, 'claim', 3);
  expect((await decideDocumentProposal(sourceId, editor, input.id, 'complete', 4)).proposal).toMatchObject({ status: 'applied', version: 5 });
  const events = jest.mocked(assessmentBroker.publish).mock.calls.length;
  expect((await decideDocumentProposal(sourceId, editor, input.id, 'complete', 4)).proposal).toMatchObject({ status: 'applied', version: 5 });
  expect(assessmentBroker.publish).toHaveBeenCalledTimes(events);
  await expect(decideDocumentProposal(sourceId, editor, input.id, 'claim', 5)).rejects.toMatchObject({ status: 409 });
});
it('uses CAS for two editing tabs and persists discard without modifying document content', async () => {
  await createDocumentProposal(sourceId, editor, input);
  const results = await Promise.allSettled([decideDocumentProposal(sourceId, editor, input.id, 'claim', 1), decideDocumentProposal(sourceId, editor, input.id, 'claim', 1)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  await decideDocumentProposal(sourceId, editor, input.id, 'release', 2);
  expect((await decideDocumentProposal(sourceId, editor, input.id, 'discard', 3)).proposal.status).toBe('discarded');
  expect((await listDocumentProposals(sourceId, reader)).proposals[0]!.status).toBe('discarded');
  expect(exec).not.toHaveBeenCalled();
});
it('checks current grant and epoch before opening storage and rejects other tenants even for admin', async () => {
  await expect(listDocumentProposals(sourceId, { ...editor, tenant: 'orgiq', role: 'admin' })).rejects.toMatchObject({ status: 403 });
  expect(getKnowledgeDoc).not.toHaveBeenCalled();
  jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: ['lead-assessor'] }, 3));
  await expect(listDocumentProposals(sourceId, editor)).rejects.toMatchObject({ status: 403 });
  jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: [] }));
  await expect(createDocumentProposal(sourceId, editor, input)).rejects.toMatchObject({ status: 403 });
  expect(ensureDocumentMapping).not.toHaveBeenCalled();
  expect(documentProposalsFixture.rows()).toHaveLength(0);
});
it('fails closed during an identity outage and respects current masquerade actor revocation', async () => {
  jest.mocked(getUser).mockRejectedValueOnce(new Error('identity offline'));
  await expect(listDocumentProposals(sourceId, editor)).rejects.toThrow('identity offline');
  await expect(listDocumentProposals(sourceId, { ...editor, act: { sub: 'operator', epoch: 2, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } })).rejects.toMatchObject({ status: 403 });
  expect(getKnowledgeDoc).not.toHaveBeenCalled();
});
it('refuses missing/read-only sources and a locked or mismatched canonical write policy', async () => {
  jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
  await expect(listDocumentProposals('missing', editor)).rejects.toMatchObject({ status: 404 });
  jest.mocked(getKnowledgeDoc).mockResolvedValueOnce({ id: sourceId, title: 'Guide', markdown: '# Guide', classification: 'internal', editable: false, path: '', updated_at: clock.nowIso() });
  await expect(createDocumentProposal(sourceId, editor, input)).rejects.toMatchObject({ status: 403 });
  jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId: DOC, canWrite: false } });
  await expect(createDocumentProposal(sourceId, editor, input)).rejects.toMatchObject({ status: 409 });
  jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId: OTHER, canWrite: true } });
  await expect(createDocumentProposal(sourceId, editor, input)).rejects.toMatchObject({ status: 409 });
  expect(documentProposalsFixture.rows()).toHaveLength(0);
});
it('keeps draft data readable but removes editing controls when the canonical write policy is locked or unavailable', async () => {
  await createDocumentProposal(sourceId, editor, input);
  jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId: DOC, canWrite: false } });
  expect(await listDocumentProposals(sourceId, editor)).toMatchObject({ canEdit: false, proposals: [{ id: input.id }] });
  jest.mocked(performDocumentWorkflow).mockRejectedValueOnce(new Error('policy offline'));
  expect(await listDocumentProposals(sourceId, editor)).toMatchObject({ canEdit: false, proposals: [{ id: input.id }] });
});
it('does not expose another document through a forged proposal id, and reset removes mutations', async () => {
  await createDocumentProposal(sourceId, editor, input);
  expect((await listDocumentProposals('local:other.md', editor)).proposals).toEqual([]);
  jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId: OTHER, canWrite: true } });
  await expect(decideDocumentProposal('local:other.md', editor, input.id, 'claim', 1)).rejects.toMatchObject({ status: 404 });
  documentProposalsFixture.reset();
  expect((await listDocumentProposals(sourceId, editor)).proposals).toEqual([]);
});
it('keeps an older unresolved proposal visible when 100 newer terminal rows fill the history page', async () => {
  const created = await createDocumentProposal(sourceId, editor, input);
  const rows = documentProposalsFixture.rows();
  rows[0]!.createdAt = '2026-09-01T00:00:00.000Z';
  for (let index = 0; index < 100; index++) {
    rows.push({ ...created.proposal, id: `terminal-${index}`, status: index % 2 ? 'applied' : 'discarded', createdAt: '2026-09-02T00:00:00.000Z' });
  }
  const page = await listDocumentProposals(sourceId, reader);
  expect(page.proposals).toHaveLength(100);
  expect(page.proposals[0]).toMatchObject({ id: input.id, status: 'ready' });
});
it('drops a notification for a revoked owner and preserves a stored draft when delivery fails', async () => {
  jest.mocked(getUser).mockImplementation(async id => identity(id, id === 'owner' ? { orgiq: ['member'] } : { assessment: ['lead-assessor'] }));
  await createDocumentProposal(sourceId, editor, input); await tick(); expect(send).not.toHaveBeenCalled();
  jest.mocked(getUser).mockImplementation(async id => identity(id));
  send.mockRejectedValueOnce(new Error('gateway offline'));
  expect((await createDocumentProposal(sourceId, editor, { ...input, id: 'edit-next' })).created).toBe(true);
  await tick(); expect(documentProposalsFixture.rows()).toHaveLength(2);
});

describe('notification proposal reads', () => {
  it.each(['ready', 'applying', 'applied', 'discarded'] as const)('resolves a %s target for an authorized reader without proposal mutations or announcements', async status => {
    const row = draft({ status, version: status === 'ready' ? 1 : 3, decidedBy: status === 'ready' ? null : 'editor' });
    documentProposalsFixture.rows().push(row);
    const before = structuredClone(row);
    const opened = await getDocumentProposal(sourceId, reader, input.id);
    expect(opened).toEqual({ documentId: DOC, proposal: before, canEdit: false });
    opened.proposal.content.text = 'client-local change';
    expect(documentProposalsFixture.rows()).toEqual([before]);
    expect(getUser).toHaveBeenCalledWith('reader', { authoritative: true });
    expect(performDocumentWorkflow).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('resolves an older ready target omitted from a full active page', async () => {
    const rows = documentProposalsFixture.rows();
    rows.push(draft());
    for (let index = 0; index < 100; index++) rows.push(draft({ id: `active-${index}`, createdAt: '2026-09-02T00:00:00.000Z' }));
    const page = await listDocumentProposals(sourceId, reader);
    expect(page.proposals).toHaveLength(100);
    expect(page.proposals.some(row => row.id === input.id)).toBe(false);
    expect(await getDocumentProposal(sourceId, reader, input.id)).toMatchObject({ proposal: { id: input.id, status: 'ready' } });
  });
  it('returns not found for a missing target or a valid target on another source, even if a fixture has a mismatched source', async () => {
    documentProposalsFixture.rows().push(draft());
    await expect(getDocumentProposal(sourceId, reader, 'edit-missing')).rejects.toMatchObject({ status: 404 });
    await expect(getDocumentProposal('local:other.md', reader, input.id)).rejects.toMatchObject({ status: 404 });
    documentProposalsFixture.rows()[0]!.sourceId = 'local:other.md';
    await expect(getDocumentProposal(sourceId, reader, input.id)).rejects.toMatchObject({ status: 404 });
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
    await expect(getDocumentProposal('missing', reader, input.id)).rejects.toMatchObject({ status: 404 });
    expect(performDocumentWorkflow).not.toHaveBeenCalled();
  });
  it('validates target ids before opening document storage', async () => {
    for (const id of ['../outside', '', 'x'.repeat(129), 'edit%00']) {
      await expect(getDocumentProposal(sourceId, reader, id)).rejects.toMatchObject({ status: 400 });
    }
    expect(getUser).not.toHaveBeenCalled(); expect(getKnowledgeDoc).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  });
  it('rechecks the authoritative epoch, role grant and read capability on every target read', async () => {
    documentProposalsFixture.rows().push(draft());
    expect((await getDocumentProposal(sourceId, editor, input.id)).canEdit).toBe(true);
    jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: ['assessor'] }));
    await expect(getDocumentProposal(sourceId, editor, input.id)).rejects.toMatchObject({ status: 403 });
    jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: ['lead-assessor'] }, 3));
    await expect(getDocumentProposal(sourceId, editor, input.id)).rejects.toMatchObject({ status: 403 });
    jest.mocked(isAllowed).mockResolvedValueOnce(false);
    await expect(getDocumentProposal(sourceId, editor, input.id)).rejects.toMatchObject({ status: 403 });
    await expect(getDocumentProposal(sourceId, { ...editor, tenant: 'orgiq', role: 'admin' }, input.id)).rejects.toMatchObject({ status: 403 });
    expect(getKnowledgeDoc).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled(); expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('fails closed on an identity outage or a revoked masquerade actor', async () => {
    documentProposalsFixture.rows().push(draft());
    jest.mocked(getUser).mockRejectedValueOnce(new Error('identity offline'));
    await expect(getDocumentProposal(sourceId, editor, input.id)).rejects.toThrow('identity offline');
    await expect(getDocumentProposal(sourceId, { ...editor, act: { sub: 'operator', epoch: 2, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } }, input.id)).rejects.toMatchObject({ status: 403 });
    expect(getKnowledgeDoc).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  });
  it.each([
    { status: 200, body: { documentId: DOC, canWrite: false } },
    { status: 200, body: { documentId: OTHER, canWrite: true } },
    { status: 503, body: { error: 'policy unavailable' } },
  ])('preserves a readable target but removes edit permission for policy result %#', async policy => {
    documentProposalsFixture.rows().push(draft());
    expect((await getDocumentProposal(sourceId, editor, input.id)).canEdit).toBe(true);
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce(policy);
    expect(await getDocumentProposal(sourceId, editor, input.id)).toMatchObject({ canEdit: false, proposal: { id: input.id } });
    expect(performDocumentWorkflow).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled(); expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('keeps the target readable on a thrown write-policy outage and for a read-only source', async () => {
    documentProposalsFixture.rows().push(draft());
    jest.mocked(performDocumentWorkflow).mockRejectedValueOnce(new Error('policy offline'));
    expect(await getDocumentProposal(sourceId, editor, input.id)).toMatchObject({ canEdit: false, proposal: { id: input.id } });
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce({ id: sourceId, title: 'Guide', markdown: '# Guide', classification: 'internal', editable: false, path: '', updated_at: clock.nowIso() });
    expect(await getDocumentProposal(sourceId, editor, input.id)).toMatchObject({ canEdit: false, proposal: { id: input.id } });
    expect(performDocumentWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('ready proposal revisions', () => {
  it('revises the same ready draft while preserving its original anchor and author, then announces metadata only', async () => {
    const original = draft({ kind: 'replace', anchor: { from: 3, to: 10 }, originalText: 'Passage', cursor: 10, createdBy: 'first-author' });
    documentProposalsFixture.rows().push(original);
    // Frozen: the provider and the assertion each read the clock, and a
    // millisecond tick between them made this flaky under load.
    const frozenAt = clock.nowIso();
    const restore = freezeClock(frozenAt);
    let result: Awaited<ReturnType<typeof reviseDocumentProposal>>;
    try { result = await reviseDocumentProposal(sourceId, editor, input.id, revision); } finally { restore(); }
    expect(result).toMatchObject({ documentId: DOC, replayed: false, proposal: { id: input.id, status: 'ready', version: 2,
      instruction: revision.instruction, content: revision.content, summary: revision.summary, decidedBy: editor.sub } });
    for (const field of ['id', 'documentId', 'sourceId', 'kind', 'anchor', 'originalText', 'cursor', 'createdBy', 'createdAt'] as const) {
      expect(result.proposal[field]).toEqual(original[field]);
    }
    expect(result.proposal.updatedAt).toBe(frozenAt);
    expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
    expect(assessmentBroker.publish).toHaveBeenCalledWith({ type: 'knowledge.proposal.changed', doc_id: sourceId,
      id: input.id, status: 'ready', version: 2, by: editor.sub, ts: result.proposal.updatedAt });
    expect(send).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
    expect(performDocumentWorkflow).toHaveBeenCalledWith(sourceId, editor, { kind: 'write-policy', method: 'GET' });
    expect(performDocumentWorkflow).toHaveBeenCalledTimes(1);
    result.proposal.anchor = 'cursor'; result.proposal.content.text = 'local-only change';
    expect(documentProposalsFixture.rows()[0]).toMatchObject({ anchor: { from: 3, to: 10 }, content: revision.content });
  });
  it('replays a lost response only for the same actor, body and preceding version without another event', async () => {
    documentProposalsFixture.rows().push(draft());
    const first = await reviseDocumentProposal(sourceId, editor, input.id, revision);
    expect(await reviseDocumentProposal(sourceId, editor, input.id, revision)).toEqual({ ...first, replayed: true });
    for (const changed of [
      { ...revision, content: { text: 'A different revision' } }, { ...revision, instruction: 'A different instruction' },
      { ...revision, summary: 'A different summary' }, { ...revision, summary: undefined },
    ]) await expect(reviseDocumentProposal(sourceId, editor, input.id, changed)).rejects.toMatchObject({ status: 409 });
    await expect(reviseDocumentProposal(sourceId, { ...editor, sub: 'another-editor' }, input.id, revision)).rejects.toMatchObject({ status: 409 });
    expect(assessmentBroker.publish).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    expect(documentProposalsFixture.rows()[0]).toEqual(first.proposal);
  });
  it('clears an omitted summary and keeps that exact revision retryable', async () => {
    documentProposalsFixture.rows().push(draft());
    const withoutSummary = { version: revision.version, instruction: revision.instruction, content: revision.content };
    const first = await reviseDocumentProposal(sourceId, editor, input.id, withoutSummary);
    expect(first.proposal).not.toHaveProperty('summary');
    expect((await reviseDocumentProposal(sourceId, editor, input.id, withoutSummary)).replayed).toBe(true);
    expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
  });
  it.each(['claim', 'discard'] as const)('refuses a revision after a competing %s and cannot overwrite its decision', async action => {
    documentProposalsFixture.rows().push(draft());
    const decision = await decideDocumentProposal(sourceId, editor, input.id, action, 1);
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 409 });
    expect(documentProposalsFixture.rows()).toEqual([decision.proposal]);
    expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
  });
  it('makes a competing revision or old-version Apply lose CAS, and a later release cannot impersonate a revision retry', async () => {
    documentProposalsFixture.rows().push(draft());
    const results = await Promise.allSettled([
      reviseDocumentProposal(sourceId, editor, input.id, revision),
      reviseDocumentProposal(sourceId, { ...editor, sub: 'another-editor' }, input.id, revision),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    await expect(decideDocumentProposal(sourceId, editor, input.id, 'claim', 1)).rejects.toMatchObject({ status: 409 });
    await decideDocumentProposal(sourceId, editor, input.id, 'claim', 2);
    await decideDocumentProposal(sourceId, editor, input.id, 'release', 3);
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 409 });
    expect(documentProposalsFixture.rows()[0]).toMatchObject({ version: 4, status: 'ready', decidedBy: null });
  });
  it('rejects missing/wrong-source revisions and leaves all proposal rows unchanged', async () => {
    documentProposalsFixture.rows().push(draft());
    const before = structuredClone(documentProposalsFixture.rows());
    await expect(reviseDocumentProposal(sourceId, editor, 'edit-missing', revision)).rejects.toMatchObject({ status: 404 });
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId: OTHER, canWrite: true } });
    await expect(reviseDocumentProposal('local:other.md', editor, input.id, revision)).rejects.toMatchObject({ status: 404 });
    expect(documentProposalsFixture.rows()).toEqual(before); expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('rechecks current grants, epoch and tenant even for an otherwise exact response-loss retry', async () => {
    documentProposalsFixture.rows().push(draft());
    const first = await reviseDocumentProposal(sourceId, editor, input.id, revision);
    await expect(reviseDocumentProposal(sourceId, reader, input.id, revision)).rejects.toMatchObject({ status: 403 });
    jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: ['assessor'] }));
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 403 });
    jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: ['lead-assessor'] }, 3));
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 403 });
    await expect(reviseDocumentProposal(sourceId, { ...editor, tenant: 'orgiq', role: 'admin' }, input.id, revision)).rejects.toMatchObject({ status: 403 });
    expect(documentProposalsFixture.rows()).toEqual([first.proposal]); expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
  });
  it('fails closed on identity outage, revoked masquerade, read-only/missing source and canonical policy refusal', async () => {
    documentProposalsFixture.rows().push(draft());
    const before = structuredClone(documentProposalsFixture.rows());
    jest.mocked(getUser).mockRejectedValueOnce(new Error('identity offline'));
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toThrow('identity offline');
    await expect(reviseDocumentProposal(sourceId, { ...editor, act: { sub: 'operator', epoch: 2, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } } }, input.id, revision)).rejects.toMatchObject({ status: 403 });
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 404 });
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce({ id: sourceId, title: 'Guide', markdown: '# Guide', classification: 'internal', editable: false, path: '', updated_at: clock.nowIso() });
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 403 });
    for (const policy of [{ status: 200, body: { documentId: DOC, canWrite: false } }, { status: 200, body: { documentId: OTHER, canWrite: true } }]) {
      jest.mocked(performDocumentWorkflow).mockResolvedValueOnce(policy);
      await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 409 });
    }
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 503, body: {} });
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 503 });
    jest.mocked(performDocumentWorkflow).mockRejectedValueOnce(new Error('policy offline'));
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toThrow('policy offline');
    expect(documentProposalsFixture.rows()).toEqual(before); expect(assessmentBroker.publish).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});

describe('live SQL adapter', () => {
  let stored: Map<string, DocumentEditProposal>;
  const sqlRow = (p: DocumentEditProposal) => ({ proposal_id: p.id, document_id: p.documentId, source_id: p.sourceId, kind: p.kind, anchor: JSON.stringify(p.anchor),
    content: p.content.text, original_text: p.originalText, cursor_position: p.cursor, instruction: p.instruction, summary: p.summary ?? null,
    status: p.status, version: p.version, created_by: p.createdBy, producer_agent: p.producer === null ? null : 'orgiq-assessment-drafter', decided_by: p.decidedBy, created_at: p.createdAt, updated_at: p.updatedAt });
  beforeEach(() => {
    (config.mock as { aurora: boolean }).aurora = false; stored = new Map();
    jest.mocked(exec).mockImplementation(async (sql, parameters = []) => {
      const values = Object.fromEntries(parameters.map(p => [p.name, p.value?.stringValue ?? p.value?.longValue ?? null]));
      const key = `${values.document}:${values.id}`;
      if (sql.startsWith('INSERT')) {
        if (stored.has(key)) return [];
        const row: DocumentEditProposal = { id: String(values.id), documentId: String(values.document), sourceId: String(values.source), kind: values.kind as 'insert',
          anchor: JSON.parse(String(values.anchor)), content: { text: String(values.content) }, originalText: String(values.original), cursor: Number(values.cursor),
          instruction: String(values.instruction), ...(typeof values.summary === 'string' ? { summary: values.summary } : {}), status: 'ready', version: 1,
          createdBy: String(values.by), producer: values.agent === 'orgiq-assessment-drafter' ? 'Assessment drafter' : null, decidedBy: null, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' };
        stored.set(key, row); return [sqlRow(row)];
      }
      if (sql.startsWith('UPDATE')) {
        const row = stored.get(key);
        if (sql.includes('SET content = :content')) {
          if (!row || row.sourceId !== values.source || row.status !== 'ready' || row.version !== values.version) return [];
          row.content = { text: String(values.content) }; row.instruction = String(values.instruction);
          if (values.summary === null) delete row.summary; else row.summary = String(values.summary);
          row.version += 1; row.decidedBy = String(values.by); row.updatedAt = clock.nowIso();
          return [sqlRow(row)];
        }
        if (!row || row.version !== values.version || row.status !== values.previous || (sql.includes('AND decided_by = :by') && row.decidedBy !== values.by)) return [];
        row.status = values.next as DocumentEditProposal['status']; row.version += 1; row.decidedBy = values.decider as string | null;
        return [sqlRow(row)];
      }
      let rows = [...stored.values()].filter(row => row.documentId === values.document && (!values.id || row.id === values.id)
        && (!values.source || row.sourceId === values.source));
      if (sql.includes('ORDER BY')) rows.sort((a, b) => Number(!['ready', 'applying'].includes(a.status)) - Number(!['ready', 'applying'].includes(b.status))
        || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      if (sql.includes('LIMIT 100')) rows = rows.slice(0, 100);
      return rows.map(sqlRow);
    });
  });
  it('rehydrates durable data on separate reads and uses conditional updates for concurrent claims', async () => {
    const first = await createDocumentProposal(sourceId, editor, input);
    expect((await listDocumentProposals(sourceId, reader)).proposals).toEqual([first.proposal]);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("CASE WHEN status IN ('ready', 'applying') THEN 0 ELSE 1 END"), expect.any(Array));
    expect((await createDocumentProposal(sourceId, editor, input)).created).toBe(false);
    const results = await Promise.allSettled([decideDocumentProposal(sourceId, editor, input.id, 'claim', 1), decideDocumentProposal(sourceId, editor, input.id, 'claim', 1)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('AND status = :previous AND version = :version'), expect.any(Array));
    expect((await decideDocumentProposal(sourceId, editor, input.id, 'complete', 2)).proposal.status).toBe('applied');
    expect((await decideDocumentProposal(sourceId, editor, input.id, 'complete', 2)).proposal).toMatchObject({ status: 'applied', version: 3 });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('AND decided_by = :by'), expect.any(Array));
    expect(documentProposalsFixture.rows()).toEqual([]);
  });
  it('does not publish or notify a failed durable write', async () => {
    jest.mocked(exec).mockRejectedValueOnce(new Error('database offline'));
    await expect(createDocumentProposal(sourceId, editor, input)).rejects.toThrow('database offline');
    await tick(); expect(assessmentBroker.publish).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('reads a target beyond the active cap with all source and document predicates, without writing', async () => {
    stored.set(`${DOC}:${input.id}`, draft());
    for (let index = 0; index < 100; index++) {
      const row = draft({ id: `active-${index}`, createdAt: '2026-09-02T00:00:00.000Z' });
      stored.set(`${DOC}:${row.id}`, row);
    }
    const page = await listDocumentProposals(sourceId, reader);
    expect(page.proposals).toHaveLength(100); expect(page.proposals.some(row => row.id === input.id)).toBe(false);
    jest.mocked(exec).mockClear();
    const found = await getDocumentProposal(sourceId, reader, input.id);
    expect(found).toEqual({ documentId: DOC, proposal: draft(), canEdit: false });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('WHERE document_id = CAST(:document AS uuid) AND source_id = :source AND proposal_id = :id'), [
      { name: 'document', value: { stringValue: DOC } }, { name: 'source', value: { stringValue: sourceId } }, { name: 'id', value: { stringValue: input.id } },
    ]);
    expect(jest.mocked(exec).mock.calls[0]![0]).not.toContain('LIMIT');
    found.proposal.content.text = 'client-local change';
    expect(stored.get(`${DOC}:${input.id}`)?.content.text).toBe(input.content.text);
    expect(send).not.toHaveBeenCalled(); expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('rehydrates current terminal state from SQL on each exact read and rejects cross-source ids', async () => {
    stored.set(`${DOC}:${input.id}`, draft());
    expect((await getDocumentProposal(sourceId, editor, input.id)).proposal.status).toBe('ready');
    stored.set(`${DOC}:${input.id}`, draft({ status: 'applied', version: 3, decidedBy: 'editor' }));
    expect((await getDocumentProposal(sourceId, editor, input.id)).proposal).toMatchObject({ status: 'applied', version: 3 });
    stored.set(`${DOC}:${input.id}`, draft({ status: 'discarded', version: 4, decidedBy: 'editor' }));
    expect((await getDocumentProposal(sourceId, reader, input.id)).proposal).toMatchObject({ status: 'discarded', version: 4 });
    await expect(getDocumentProposal('local:other.md', reader, input.id)).rejects.toMatchObject({ status: 404 });
    await expect(getDocumentProposal(sourceId, reader, 'edit-missing')).rejects.toMatchObject({ status: 404 });
    expect(jest.mocked(exec).mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
    expect(send).not.toHaveBeenCalled(); expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('rechecks current role access and tolerates a canonical policy outage before returning SQL draft data', async () => {
    stored.set(`${DOC}:${input.id}`, draft());
    jest.mocked(performDocumentWorkflow).mockRejectedValueOnce(new Error('policy offline'));
    expect(await getDocumentProposal(sourceId, editor, input.id)).toMatchObject({ canEdit: false, proposal: { id: input.id } });
    jest.mocked(getUser).mockResolvedValueOnce(identity('editor', { assessment: ['assessor'] }));
    await expect(getDocumentProposal(sourceId, editor, input.id)).rejects.toMatchObject({ status: 403 });
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('performs an exact ready-only SQL revision, preserves original authority and replays a lost response once', async () => {
    const original = draft({ kind: 'replace', anchor: { from: 3, to: 10 }, originalText: 'Passage', cursor: 10, createdBy: 'first-author' });
    stored.set(`${DOC}:${input.id}`, structuredClone(original));
    const first = await reviseDocumentProposal(sourceId, editor, input.id, revision);
    for (const field of ['id', 'documentId', 'sourceId', 'kind', 'anchor', 'originalText', 'cursor', 'createdBy', 'createdAt'] as const) {
      expect(first.proposal[field]).toEqual(original[field]);
    }
    expect(first).toMatchObject({ replayed: false, proposal: { status: 'ready', version: 2, content: revision.content, decidedBy: editor.sub } });
    expect(exec).toHaveBeenCalledWith(expect.stringContaining("AND status = 'ready' AND version = :version"), expect.arrayContaining([
      { name: 'document', value: { stringValue: DOC } }, { name: 'source', value: { stringValue: sourceId } }, { name: 'id', value: { stringValue: input.id } },
      { name: 'by', value: { stringValue: editor.sub } }, { name: 'version', value: { longValue: 1 } },
    ]));
    const updatedColumns = jest.mocked(exec).mock.calls[0]![0].split('WHERE')[0]!;
    for (const column of ['anchor =', 'kind =', 'cursor_position =', 'original_text =', 'source_id =', 'created_by =', 'created_at =']) expect(updatedColumns).not.toContain(column);
    expect(await reviseDocumentProposal(sourceId, editor, input.id, revision)).toEqual({ ...first, replayed: true });
    expect(jest.mocked(exec).mock.calls.at(-1)![0]).toContain('WHERE document_id = CAST(:document AS uuid) AND source_id = :source AND proposal_id = :id');
    await expect(reviseDocumentProposal(sourceId, { ...editor, sub: 'another-editor' }, input.id, revision)).rejects.toMatchObject({ status: 409 });
    await expect(reviseDocumentProposal(sourceId, editor, input.id, { ...revision, content: { text: 'Different' } })).rejects.toMatchObject({ status: 409 });
    expect(assessmentBroker.publish).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    expect(documentProposalsFixture.rows()).toEqual([]);
  });
  it('makes revision and Apply/discard compete on the same SQL version without overwriting the winner', async () => {
    for (const action of ['claim', 'discard'] as const) {
      stored.set(`${DOC}:${input.id}`, draft());
      const decision = await decideDocumentProposal(sourceId, editor, input.id, action, 1);
      await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toMatchObject({ status: 409 });
      expect(stored.get(`${DOC}:${input.id}`)).toEqual(decision.proposal);
    }
    stored.set(`${DOC}:${input.id}`, draft());
    const race = await Promise.allSettled([
      reviseDocumentProposal(sourceId, editor, input.id, revision),
      reviseDocumentProposal(sourceId, { ...editor, sub: 'another-editor' }, input.id, { ...revision, content: { text: 'Competing revision' } }),
    ]);
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    await expect(decideDocumentProposal(sourceId, editor, input.id, 'claim', 1)).rejects.toMatchObject({ status: 409 });
  });
  it('returns SQL not-found for wrong-source or missing revisions and cannot announce a failed durable write', async () => {
    stored.set(`${DOC}:${input.id}`, draft());
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId: OTHER, canWrite: true } });
    await expect(reviseDocumentProposal('local:other.md', editor, input.id, revision)).rejects.toMatchObject({ status: 404 });
    await expect(reviseDocumentProposal(sourceId, editor, 'edit-missing', revision)).rejects.toMatchObject({ status: 404 });
    jest.mocked(exec).mockRejectedValueOnce(new Error('database offline'));
    await expect(reviseDocumentProposal(sourceId, editor, input.id, revision)).rejects.toThrow('database offline');
    expect(stored.get(`${DOC}:${input.id}`)).toEqual(draft());
    expect(assessmentBroker.publish).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
});

it.each([
  { ...input, createdBy: 'admin' }, { ...input, status: 'applied' }, { ...input, version: 99 },
  { ...input, kind: 'replace', anchor: { from: 1, to: 0 } }, { ...input, cursor: Infinity },
  { ...input, content: { text: 'x'.repeat(24001) } }, { ...input, instruction: '' },
  { ...input, id: '../outside' }, { ...input, content: { html: '<script>run()</script>' } },
])('rejects malformed or authority-bearing proposal input %#', value => {
  expect(() => parseDocumentProposal(value)).toThrow();
});
it.each([
  { ...revision, createdBy: 'admin' }, { ...revision, decidedBy: 'admin' }, { ...revision, status: 'ready' },
  { ...revision, id: 'different' }, { ...revision, sourceId: 'local:other.md' }, { ...revision, documentId: OTHER },
  { ...revision, anchor: 'cursor' }, { ...revision, kind: 'replace' }, { ...revision, cursor: 8 }, { ...revision, originalText: 'Different' },
  { ...revision, version: 0 }, { ...revision, version: 1.5 }, { ...revision, version: '1' },
  { ...revision, instruction: '' }, { ...revision, instruction: 'x'.repeat(2001) }, { ...revision, summary: 'x'.repeat(501) },
  { ...revision, content: { html: '<b>Different</b>' } }, { ...revision, content: { text: 'x', actor: 'admin' } },
  { ...revision, content: { text: '' } }, { ...revision, content: { text: 'x'.repeat(24001) } },
])('rejects malformed or authority-bearing revision input %#', value => {
  expect(() => parseDocumentProposalRevision(value)).toThrow();
});

// Slice 9: per-suggestion accept/reject. The portal splits a draft into whole
// blocks (portal documentSuggestionsModel) and commits the verdicts through
// these existing operations only: Discard when nothing is accepted, Apply when
// everything is, and otherwise a CAS revision narrowing the SAME row to the
// accepted blocks followed by the ordinary claim -> complete. No new route.
describe('per-suggestion review commits through the existing proposal operations', () => {
  const BLOCKS = ['## Recipe Format', '- Ingredients\n- Instructions', 'A closing paragraph.'];
  const multi = () => draft({ content: { text: BLOCKS.join('\n\n') }, summary: 'Adds a recipe section' });
  const narrow = (blocks: string[], version = 1): DocumentProposalRevision =>
    ({ version, instruction: input.instruction, content: { text: blocks.join('\n\n') }, summary: 'Adds a recipe section' });

  it('a partial accept narrows the stored text to the accepted blocks, then applies once; the rejected block never lands', async () => {
    documentProposalsFixture.rows().push(multi());
    const narrowed = await reviseDocumentProposal(sourceId, editor, input.id, narrow([BLOCKS[0]!, BLOCKS[2]!]));
    expect(narrowed.proposal).toMatchObject({ status: 'ready', version: 2, content: { text: `${BLOCKS[0]}\n\n${BLOCKS[2]}` } });
    expect(narrowed.proposal.content.text).not.toContain('Ingredients');
    const claimed = await decideDocumentProposal(sourceId, editor, input.id, 'claim', 2);
    expect(claimed.proposal).toMatchObject({ status: 'applying', version: 3, decidedBy: 'editor' });
    const done = await decideDocumentProposal(sourceId, editor, input.id, 'complete', 3);
    expect(done.proposal).toMatchObject({ status: 'applied', version: 4, content: { text: `${BLOCKS[0]}\n\n${BLOCKS[2]}` } });
    // The original anchor and author are untouched by narrowing.
    expect(done.proposal).toMatchObject({ kind: 'insert', anchor: 'cursor', createdBy: 'editor' });
  });
  it('rejecting every suggestion discards the draft and keeps the stored text as it was proposed', async () => {
    documentProposalsFixture.rows().push(multi());
    const discarded = await decideDocumentProposal(sourceId, editor, input.id, 'discard', 1);
    expect(discarded.proposal).toMatchObject({ status: 'discarded', version: 2, content: { text: BLOCKS.join('\n\n') } });
    await expect(decideDocumentProposal(sourceId, editor, input.id, 'claim', 2)).rejects.toMatchObject({ status: 409 });
  });
  it('accepting every suggestion applies the unchanged stored text with no revision', async () => {
    documentProposalsFixture.rows().push(multi());
    const claimed = await decideDocumentProposal(sourceId, editor, input.id, 'claim', 1);
    expect(claimed.proposal.content.text).toBe(BLOCKS.join('\n\n'));
    expect((await decideDocumentProposal(sourceId, editor, input.id, 'complete', 2)).proposal.status).toBe('applied');
  });
  it('a lost narrowing response or lost completion replays without a second revision or a second insertion', async () => {
    documentProposalsFixture.rows().push(multi());
    const body = narrow([BLOCKS[1]!]);
    const first = await reviseDocumentProposal(sourceId, editor, input.id, body);
    const retried = await reviseDocumentProposal(sourceId, editor, input.id, body);
    expect(retried).toEqual({ ...first, replayed: true });
    expect(retried.proposal.version).toBe(2);
    await decideDocumentProposal(sourceId, editor, input.id, 'claim', 2);
    const done = await decideDocumentProposal(sourceId, editor, input.id, 'complete', 3);
    expect(await decideDocumentProposal(sourceId, editor, input.id, 'complete', 3)).toEqual({ documentId: DOC, proposal: done.proposal });
    // A claim is never idempotent: a second tab cannot receive the same narrowed edit.
    await expect(decideDocumentProposal(sourceId, editor, input.id, 'claim', 2)).rejects.toMatchObject({ status: 409 });
    expect(assessmentBroker.publish).toHaveBeenCalledTimes(3);
  });
  it('a reader sees the suggestions but cannot narrow, apply or discard them', async () => {
    documentProposalsFixture.rows().push(multi());
    const seen = await listDocumentProposals(sourceId, reader);
    expect(seen).toMatchObject({ canEdit: false, proposals: [{ content: { text: BLOCKS.join('\n\n') } }] });
    await expect(reviseDocumentProposal(sourceId, reader, input.id, narrow([BLOCKS[0]!]))).rejects.toMatchObject({ status: 403 });
    for (const action of ['claim', 'discard'] as const) {
      await expect(decideDocumentProposal(sourceId, reader, input.id, action, 1)).rejects.toMatchObject({ status: 403 });
    }
    expect(documentProposalsFixture.rows()[0]).toMatchObject({ status: 'ready', version: 1, content: { text: BLOCKS.join('\n\n') } });
    expect(assessmentBroker.publish).not.toHaveBeenCalled();
  });
  it('a narrowing racing another editor\'s decision loses CAS and leaves the winner intact', async () => {
    documentProposalsFixture.rows().push(multi());
    await decideDocumentProposal(sourceId, { ...editor, sub: 'second-editor' }, input.id, 'claim', 1);
    await expect(reviseDocumentProposal(sourceId, editor, input.id, narrow([BLOCKS[0]!]))).rejects.toMatchObject({ status: 409 });
    expect(documentProposalsFixture.rows()[0]).toMatchObject({ status: 'applying', content: { text: BLOCKS.join('\n\n') } });
  });
});

describe('producer', () => {
  it('records the drafter on create and keeps it through revise, list and get', async () => {
    const made = await createDocumentProposal(sourceId, editor, input);
    expect(made.proposal.producer).toBe('Assessment drafter');
    const revised = await reviseDocumentProposal(sourceId, editor, input.id, revision);
    expect(revised.proposal.producer).toBe('Assessment drafter');
    expect((await listDocumentProposals(sourceId, reader)).proposals[0]!.producer).toBe('Assessment drafter');
    expect((await getDocumentProposal(sourceId, reader, input.id)).proposal.producer).toBe('Assessment drafter');
  });
  it('reads an older stored row as null, and an unknown agent id as null', () => {
    expect(producerLabel(null)).toBeNull(); expect(producerLabel(undefined)).toBeNull(); expect(producerLabel('some-other-agent')).toBeNull();
    expect(producerLabel('orgiq-assessment-drafter')).toBe('Assessment drafter');
  });
  it('lets a client-supplied producer be refused', async () => {
    await expect(Promise.resolve().then(() => parseDocumentProposal({ ...input, producer: 'x' }))).rejects.toThrow();
  });
});
