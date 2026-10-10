jest.mock('../../providers/document-proposals.js', () => ({ listDocumentProposals: jest.fn(), getDocumentProposal: jest.fn(), createDocumentProposal: jest.fn(), decideDocumentProposal: jest.fn(), reviseDocumentProposal: jest.fn() }));
import express, { type Request, type Response } from 'express';
import request from '../../test-support/http.js';
import type { Session } from '../../lib/session.js';
import { DocumentProposalError } from '../../lib/document-proposals.js';
import { listDocumentProposals, getDocumentProposal, createDocumentProposal, decideDocumentProposal, reviseDocumentProposal } from '../../providers/document-proposals.js';
import { assessmentDocumentProposalsRouter } from '../assessment-document-proposals.js';
const session: Session = { sub: 'editor', role: 'lead-assessor', tenant: 'assessment', grants: { assessment: ['lead-assessor'] }, iat: 1 };
const body = { id: 'edit-1', kind: 'insert', anchor: 'cursor', content: { text: 'Proposed text' }, originalText: '', cursor: 1, instruction: 'Clarify' };
const revision = { version: 1, instruction: 'Make it shorter', content: { text: 'Shorter proposal' }, summary: 'Shortened' };
function app(current: Session | null = session) {
  return express().use(express.json()).use((req, _res, next) => { if (current) req.session = current; next(); }).use('/api/assessment/knowledge', assessmentDocumentProposalsRouter);
}
beforeEach(() => { jest.clearAllMocks(); jest.mocked(listDocumentProposals).mockResolvedValue({ documentId: 'uuid', proposals: [], canEdit: true });
  jest.mocked(getDocumentProposal).mockResolvedValue({ documentId: 'uuid', proposal: body as never, canEdit: false });
  jest.mocked(createDocumentProposal).mockResolvedValue({ documentId: 'uuid', created: true, proposal: body as never });
  jest.mocked(reviseDocumentProposal).mockResolvedValue({ documentId: 'uuid', replayed: false, proposal: { ...body, ...revision, status: 'ready', version: 2 } as never });
  jest.mocked(decideDocumentProposal).mockResolvedValue({ documentId: 'uuid', proposal: body as never }); });
it('requires an actual session, without the anonymous demo fallback', async () => {
  expect((await request(app(null)).get('/api/assessment/knowledge/doc/proposals?id=local')).status).toBe(401);
  expect((await request(app(null)).get('/api/assessment/knowledge/doc/proposals/edit-1?id=local')).status).toBe(401);
  expect((await request(app(null)).post('/api/assessment/knowledge/doc/proposals?id=local').send(body)).status).toBe(401);
  expect((await request(app(null)).post('/api/assessment/knowledge/doc/proposals/edit-1/revision?id=local').send(revision)).status).toBe(401);
  expect(listDocumentProposals).not.toHaveBeenCalled(); expect(getDocumentProposal).not.toHaveBeenCalled(); expect(createDocumentProposal).not.toHaveBeenCalled();
  expect(reviseDocumentProposal).not.toHaveBeenCalled();
});
it('uses the source id and session on read, with no-store caching', async () => {
  const result = await request(app()).get('/api/assessment/knowledge/doc/proposals?id=local%3Aguide.md');
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(listDocumentProposals).toHaveBeenCalledWith('local:guide.md', session);
});
it('resolves an exact notification target with the current session, source id and no-store caching', async () => {
  const result = await request(app()).get('/api/assessment/knowledge/doc/proposals/edit%3A1?id=local%3Aguide.md');
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toEqual({ documentId: 'uuid', proposal: body, canEdit: false });
  expect(getDocumentProposal).toHaveBeenCalledWith('local:guide.md', session, 'edit:1');
  expect(listDocumentProposals).not.toHaveBeenCalled(); expect(createDocumentProposal).not.toHaveBeenCalled(); expect(decideDocumentProposal).not.toHaveBeenCalled();
});
it('rejects malformed proposal ids and document queries before provider access', async () => {
  for (const url of ['/api/assessment/knowledge/doc/proposals/edit%20invalid?id=local', '/api/assessment/knowledge/doc/proposals/edit-1', '/api/assessment/knowledge/doc/proposals/edit-1?id=local&id=other']) {
    expect((await request(app()).get(url)).status).toBe(400);
  }
  expect(getDocumentProposal).not.toHaveBeenCalled();
});
it.each([403, 404])('preserves exact-target authorization/not-found status %i', async status => {
  jest.mocked(getDocumentProposal).mockRejectedValueOnce(new DocumentProposalError(status, 'Cannot open target'));
  const result = await request(app()).get('/api/assessment/knowledge/doc/proposals/edit-1?id=local');
  expect(result.status).toBe(status); expect(result.body.error).toBe('Cannot open target');
});
it('returns a recoverable exact-target service error without leaking provider details', async () => {
  jest.mocked(getDocumentProposal).mockRejectedValueOnce(new Error('database detail'));
  const result = await request(app()).get('/api/assessment/knowledge/doc/proposals/edit-1?id=local');
  expect(result.status).toBe(503); expect(result.body.error).toBe('Proposed edits are unavailable. Please retry.');
  expect(result.headers['cache-control']).toBe('no-store');
});
it('validates creation and rejects browser authority fields', async () => {
  expect((await request(app()).post('/api/assessment/knowledge/doc/proposals?id=local').send(body)).status).toBe(200);
  expect(createDocumentProposal).toHaveBeenCalledWith('local', session, body);
  expect((await request(app()).post('/api/assessment/knowledge/doc/proposals?id=local').send({ ...body, createdBy: 'admin' })).status).toBe(400);
  expect(createDocumentProposal).toHaveBeenCalledTimes(1);
});
it('requires a current version on decisions and supplies the server actor', async () => {
  expect((await request(app()).post('/api/assessment/knowledge/doc/proposals/edit-1/decision?id=local').send({ action: 'claim', version: 1 })).status).toBe(200);
  expect(decideDocumentProposal).toHaveBeenCalledWith('local', session, 'edit-1', 'claim', 1);
  for (const invalid of [{ action: 'apply', version: 1 }, { action: 'complete', version: 0 }, { action: 'complete', version: 1, by: 'admin' }]) {
    expect((await request(app()).post('/api/assessment/knowledge/doc/proposals/edit-1/decision?id=local').send(invalid)).status).toBe(400);
  }
  expect(decideDocumentProposal).toHaveBeenCalledTimes(1);
});
it('revises an exact source-scoped proposal using the server session and current version, with no-store caching', async () => {
  const result = await request(app()).post('/api/assessment/knowledge/doc/proposals/edit%3A1/revision?id=local%3Aguide.md').send(revision);
  expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toMatchObject({ documentId: 'uuid', replayed: false, proposal: { content: revision.content, status: 'ready', version: 2 } });
  expect(reviseDocumentProposal).toHaveBeenCalledWith('local:guide.md', session, 'edit:1', revision);
  expect(createDocumentProposal).not.toHaveBeenCalled(); expect(decideDocumentProposal).not.toHaveBeenCalled();
});
it('passes a response-loss replay result without inventing another revision', async () => {
  jest.mocked(reviseDocumentProposal).mockResolvedValueOnce({ documentId: 'uuid', replayed: true, proposal: { ...body, ...revision, status: 'ready', version: 2 } as never });
  const result = await request(app()).post('/api/assessment/knowledge/doc/proposals/edit-1/revision?id=local').send(revision);
  expect(result.status).toBe(200); expect(result.body.replayed).toBe(true); expect(result.body.proposal.version).toBe(2);
});
it('refuses malformed revision bodies, target ids and source queries before provider access', async () => {
  for (const invalid of [
    { ...revision, createdBy: 'admin' }, { ...revision, decidedBy: 'admin' }, { ...revision, anchor: { from: 1, to: 8 } },
    { ...revision, cursor: 8 }, { ...revision, originalText: 'Different' }, { ...revision, version: 0 },
    { ...revision, content: { text: 'x', html: '<b>x</b>' } }, { ...revision, content: { text: '' } },
  ]) expect((await request(app()).post('/api/assessment/knowledge/doc/proposals/edit-1/revision?id=local').send(invalid)).status).toBe(400);
  for (const url of ['/api/assessment/knowledge/doc/proposals/edit%20invalid/revision?id=local', '/api/assessment/knowledge/doc/proposals/edit-1/revision', '/api/assessment/knowledge/doc/proposals/edit-1/revision?id=local&id=other']) {
    expect((await request(app()).post(url).send(revision)).status).toBe(400);
  }
  expect(reviseDocumentProposal).not.toHaveBeenCalled();
});
it.each([403, 404, 409, 503])('preserves revision access/not-found/conflict/policy refusal status %i', async status => {
  jest.mocked(reviseDocumentProposal).mockRejectedValueOnce(new DocumentProposalError(status, 'Cannot revise'));
  const result = await request(app()).post('/api/assessment/knowledge/doc/proposals/edit-1/revision?id=local').send(revision);
  expect(result.status).toBe(status); expect(result.body.error).toBe('Cannot revise');
});
it('returns a recoverable revision provider outage without leaking database details', async () => {
  jest.mocked(reviseDocumentProposal).mockRejectedValueOnce(new Error('database detail'));
  const result = await request(app()).post('/api/assessment/knowledge/doc/proposals/edit-1/revision?id=local').send(revision);
  expect(result.status).toBe(503); expect(result.body.error).toBe('Proposed edits are unavailable. Please retry.');
});
it.each([403, 404, 409])('preserves authorization/not-found/conflict status %i', async status => {
  jest.mocked(listDocumentProposals).mockRejectedValueOnce(new DocumentProposalError(status, 'Cannot open'));
  expect((await request(app()).get('/api/assessment/knowledge/doc/proposals?id=local')).status).toBe(status);
});
it('returns a recoverable service error for a provider outage and validates the document id', async () => {
  jest.mocked(listDocumentProposals).mockRejectedValueOnce(new Error('database detail'));
  const result = await request(app()).get('/api/assessment/knowledge/doc/proposals?id=local');
  expect(result.status).toBe(503); expect(result.body.error).not.toContain('database detail');
  expect((await request(app()).get('/api/assessment/knowledge/doc/proposals')).status).toBe(400);
});

// These exercise the actual registered Express handler without a listening
// socket. The HTTP suites above still cover URL decoding and middleware in an
// environment that permits the shared HTTP harness to bind localhost.
describe('in-process revision handler contract', () => {
  async function invoke(overrides: { current?: Session | null; query?: unknown; id?: unknown; body?: unknown } = {}) {
    const layer = assessmentDocumentProposalsRouter.stack.find(item => item.route?.path === '/doc/proposals/:proposalId/revision');
    const handler = layer?.route?.stack.find(item => item.method === 'post')?.handle;
    if (!handler) throw new Error('The POST revision route is not registered');
    const req = { session: overrides.current === null ? undefined : overrides.current ?? session,
      query: overrides.query === undefined ? { id: 'local:guide.md' } : overrides.query,
      params: { proposalId: overrides.id === undefined ? 'edit:1' : overrides.id },
      body: overrides.body === undefined ? revision : overrides.body } as unknown as Request;
    const result: { status: number; headers: Record<string, unknown>; body?: unknown } = { status: 200, headers: {} };
    const res = {
      setHeader(name: string, value: unknown) { result.headers[name.toLowerCase()] = value; return this; },
      status(status: number) { result.status = status; return this; },
      json(body: unknown) { result.body = body; return this; },
    } as unknown as Response;
    await handler(req, res, () => { throw new Error('The revision handler unexpectedly delegated'); });
    return result;
  }
  it('requires a real session before parsing or provider delegation', async () => {
    const result = await invoke({ current: null, query: {}, body: { createdBy: 'admin' } });
    expect(result).toEqual({ status: 401, headers: { 'cache-control': 'no-store' }, body: { error: 'Sign in to use proposed edits' } });
    expect(reviseDocumentProposal).not.toHaveBeenCalled();
  });
  it('delegates only the exact source, proposal, current session and validated revision body', async () => {
    const result = await invoke();
    expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({ documentId: 'uuid', replayed: false, proposal: { status: 'ready', version: 2 } });
    expect(reviseDocumentProposal).toHaveBeenCalledWith('local:guide.md', session, 'edit:1', revision);
    expect(createDocumentProposal).not.toHaveBeenCalled(); expect(decideDocumentProposal).not.toHaveBeenCalled();
  });
  it('returns a same-actor response-loss replay without adding another revision', async () => {
    jest.mocked(reviseDocumentProposal).mockResolvedValueOnce({ documentId: 'uuid', replayed: true, proposal: { ...body, ...revision, status: 'ready', version: 2 } as never });
    expect((await invoke()).body).toMatchObject({ replayed: true, proposal: { version: 2 } });
    expect(reviseDocumentProposal).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...revision, createdBy: 'admin' }, { ...revision, decidedBy: 'admin' }, { ...revision, anchor: 'cursor' },
    { ...revision, version: 0 }, { ...revision, version: '1' }, { ...revision, content: { text: 'x', html: '<b>x</b>' } },
  ])('refuses forged or malformed revision body %# before provider access', async invalid => {
    expect((await invoke({ body: invalid })).status).toBe(400);
    expect(reviseDocumentProposal).not.toHaveBeenCalled();
  });
  it.each([{}, { id: ['local', 'other'] }, { id: 'x'.repeat(1025) }])('refuses invalid source query %# before provider access', async query => {
    expect((await invoke({ query })).status).toBe(400);
    expect(reviseDocumentProposal).not.toHaveBeenCalled();
  });
  it('refuses an invalid exact proposal id before provider access', async () => {
    expect((await invoke({ id: 'edit invalid' })).status).toBe(400);
    expect(reviseDocumentProposal).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409, 503])('preserves typed provider refusal %i', async status => {
    jest.mocked(reviseDocumentProposal).mockRejectedValueOnce(new DocumentProposalError(status, 'Cannot revise'));
    expect(await invoke()).toEqual({ status, headers: { 'cache-control': 'no-store' }, body: { error: 'Cannot revise' } });
  });
  it('maps an unexpected provider failure to a recoverable response without database details', async () => {
    jest.mocked(reviseDocumentProposal).mockRejectedValueOnce(new Error('database detail'));
    expect(await invoke()).toEqual({ status: 503, headers: { 'cache-control': 'no-store' }, body: { error: 'Proposed edits are unavailable. Please retry.' } });
  });
});
