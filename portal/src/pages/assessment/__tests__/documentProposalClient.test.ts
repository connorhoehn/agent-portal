import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStoredDocumentProposal, confirmDocumentProposalReceipt, getDocumentProposal, reviseDocumentProposal, documentProposalUrl, DocumentProposalReadError, waitForDocumentProposalSave, ProposalNotInsertedError, proposalReceiptMatches, type StoredDocumentProposal, type DocumentPersistenceSource, type ProposalDecision } from '../knowledge/documentProposalClient.ts';
import { HttpError } from '../../../lib/writeJson.ts';

const proposal: StoredDocumentProposal = {
  id: 'proposal-1', documentId: 'doc-1', sourceId: 'page:100002', version: 1, createdBy: 'u-jonas', decidedBy: null,
  createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', kind: 'insert', anchor: 'cursor',
  content: { text: 'Next step' }, status: 'ready', originalText: '', cursor: 1, instruction: 'Add a next step',
};

test('a notification lookup encodes its source and exact proposal and reads terminal metadata without a decision', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const terminal = { ...proposal, status: 'discarded', version: 3 };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ documentId: 'doc-1', proposal: terminal, canEdit: false }), { status: 200 });
  };
  try {
    const result = await getDocumentProposal('ec:notes/one?other=two', 'edit:one');
    assert.equal(calls[0].url, documentProposalUrl('ec:notes/one?other=two', 'edit:one'));
    assert.equal(calls[0].url, '/api/assessment/knowledge/doc/proposals/edit%3Aone?id=ec%3Anotes%2Fone%3Fother%3Dtwo');
    assert.equal(calls[0].init?.credentials, 'include');
    assert.equal(calls[0].init?.method, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.proposal, terminal); assert.equal(result.canEdit, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('a missing notification target stays distinguishable from a temporary unavailable lookup', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [404, 503]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: status === 404 ? 'Proposed edit not found' : 'Please retry' }), { status });
      await assert.rejects(getDocumentProposal(proposal.sourceId, proposal.id), error => error instanceof DocumentProposalReadError && error.status === status);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('revision retries keep the original version and send no target or actor authority', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = { ...proposal, id: 'edit:one', sourceId: 'ec:notes/one?other=two' };
  const revised = { ...original, instruction: 'Make the next step specific', content: { text: 'Ask the owner to review the evidence.' }, summary: 'Name the reviewer' };
  const saved = { ...revised, version: 2, decidedBy: 'u-farah' };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? new Response(JSON.stringify({ error: 'Please retry the revision' }), { status: 503 })
      : new Response(JSON.stringify({ documentId: original.documentId, proposal: saved, replayed: true }), { status: 200 });
  };
  try {
    await assert.rejects(reviseDocumentProposal(original.sourceId, original, revised), error => error instanceof HttpError && error.status === 503);
    assert.deepEqual(await reviseDocumentProposal(original.sourceId, original, revised), saved);
    assert.equal(calls[0].url, '/api/assessment/knowledge/doc/proposals/edit%3Aone/revision?id=ec%3Anotes%2Fone%3Fother%3Dtwo');
    assert.equal(calls[0].init?.method, 'POST'); assert.equal(calls[0].init?.credentials, 'include');
    assert.equal(calls[0].init?.body, calls[1].init?.body);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { version: 1, instruction: revised.instruction, content: revised.content, summary: revised.summary });
  } finally { globalThis.fetch = originalFetch; }
});

test('revision conflicts preserve their status so the caller refreshes instead of retrying a stale draft', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'The proposed edit changed' }), { status: 409 });
  try {
    await assert.rejects(reviseDocumentProposal(proposal.sourceId, proposal, { ...proposal, content: { text: 'Revised' } }),
      error => error instanceof HttpError && error.status === 409 && /changed/.test(error.message));
  } finally { globalThis.fetch = originalFetch; }
});

function decisions(calls: string[]) {
  return async (record: StoredDocumentProposal, action: ProposalDecision): Promise<StoredDocumentProposal> => {
    calls.push(action);
    return { ...record, version: record.version + 1, status: action === 'claim' ? 'applying' : action === 'complete' ? 'applied' : 'ready' };
  };
}

test('Apply claims the shared proposal before insertion and completes only after persistence', async () => {
  const calls: string[] = [];
  const result = await applyStoredDocumentProposal(proposal, {
    decide: decisions(calls), insert: () => { calls.push('insert'); }, saved: async () => { calls.push('saved'); },
  });
  assert.deepEqual(calls, ['claim', 'insert', 'saved', 'complete']);
  assert.equal(result.state, 'applied');
});

test('another tab winning the claim prevents any editor change', async () => {
  let inserted = false;
  await assert.rejects(applyStoredDocumentProposal(proposal, {
    decide: async () => { throw new Error('Proposal changed in another tab'); },
    insert: () => { inserted = true; }, saved: async () => {},
  }), /another tab/);
  assert.equal(inserted, false);
});

test('document navigation or changed selection after the claim releases it before insertion', async () => {
  const calls: string[] = [];
  const result = await applyStoredDocumentProposal(proposal, {
    decide: decisions(calls), insert: () => { throw new ProposalNotInsertedError('The selected text changed'); }, saved: async () => { calls.push('saved'); },
  });
  assert.deepEqual(calls, ['claim', 'release']);
  assert.equal(result.state, 'ready');
});

test('an unexpected insertion failure cannot release a claim that might have changed the document', async () => {
  const calls: string[] = [];
  const result = await applyStoredDocumentProposal(proposal, {
    decide: decisions(calls), insert: () => { calls.push('insert'); throw new Error('Editor failed after starting a transaction'); }, saved: async () => {},
  });
  assert.equal(result.state, 'pending');
  assert.deepEqual(calls, ['claim', 'insert']);
});

test('reload recovery requires a receipt for the same document, claim version and actor', () => {
  const claimed = { ...proposal, status: 'applying' as const, version: 2, decidedBy: 'u-jonas' };
  const receipt = { id: claimed.id, sourceId: claimed.sourceId, version: 2, by: 'u-jonas' };
  assert.equal(proposalReceiptMatches(receipt, claimed), true);
  for (const other of [null, { ...receipt, id: 'another-proposal' }, { ...receipt, sourceId: 'page:another' }, { ...receipt, version: 3 }, { ...receipt, by: 'u-farah' }]) {
    assert.equal(proposalReceiptMatches(other, claimed), false);
  }
});

test('a failed save keeps the claim and never completes or releases an inserted edit', async () => {
  const calls: string[] = [];
  const result = await applyStoredDocumentProposal(proposal, {
    decide: decisions(calls), insert: () => { calls.push('insert'); }, saved: async () => { throw new Error('Store unavailable'); },
  });
  assert.deepEqual(calls, ['claim', 'insert']);
  assert.equal(result.state, 'pending');
  if (result.state === 'pending') assert.equal(result.saved, false);
});

test('lost proposal confirmation preserves the saved receipt so Retry never inserts twice', async () => {
  const calls: string[] = [];
  const decide = decisions(calls);
  const result = await applyStoredDocumentProposal(proposal, {
    decide: async (record, action) => { if (action === 'complete') throw new Error('Connection lost'); return decide(record, action); },
    insert: () => { calls.push('insert'); }, saved: async () => {},
  });
  assert.equal(result.state, 'pending');
  if (result.state === 'pending') {
    assert.equal(result.saved, true);
    await decide(result.proposal, 'complete');
  }
  assert.equal(calls.filter(call => call === 'insert').length, 1);
});

function persistence() {
  let listener: (() => void) | undefined;
  const provider: DocumentPersistenceSource & { persistenceState: string; pendingUpdateCount: number; emit: () => void } = {
    persistenceState: 'pending', pendingUpdateCount: 1,
    on: (_event, callback) => { listener = callback; }, off: () => { listener = undefined; },
    flushUpdates: () => {}, retryPersistence: () => {}, emit: () => listener?.(),
  };
  return provider;
}

test('a document acknowledgement waits for zero pending updates and unregisters after completion', async () => {
  const provider = persistence(); let resolved = false;
  const saved = waitForDocumentProposalSave(provider).then(() => { resolved = true; });
  provider.persistenceState = 'saved'; provider.emit(); await Promise.resolve();
  assert.equal(resolved, false);
  provider.pendingUpdateCount = 0; provider.emit(); await saved;
  provider.persistenceState = 'error'; provider.emit(); // removed listener must have no effect
  assert.equal(resolved, true);
});

test('failed and timed out persistence cannot be mistaken for a saved proposal', async () => {
  const provider = persistence();
  const failed = waitForDocumentProposalSave(provider);
  provider.persistenceState = 'error'; provider.emit();
  await assert.rejects(failed, /not saved/);
  provider.persistenceState = 'pending';
  await assert.rejects(waitForDocumentProposalSave(provider, false, 1), /not been confirmed/);
});

test('a recovered idle snapshot reconfirms only its receipt and waits for a new durable acknowledgement', async () => {
  const provider = persistence(); provider.persistenceState = 'idle'; provider.pendingUpdateCount = 0;
  const claimed = { ...proposal, status: 'applying' as const, version: 2, decidedBy: 'u-jonas' };
  let receipt: Record<string, unknown> = { id: claimed.id, sourceId: claimed.sourceId, version: claimed.version, by: claimed.decidedBy };
  let writes = 0;
  const saved = confirmDocumentProposalReceipt(provider, {
    get: () => receipt,
    set: (_id, value) => { writes += 1; receipt = value; provider.persistenceState = 'pending'; provider.pendingUpdateCount = 1; },
  }, claimed);
  assert.equal(writes, 1);
  assert.equal(typeof receipt.confirmationId, 'string');
  provider.persistenceState = 'saved'; provider.pendingUpdateCount = 0; provider.emit();
  await saved;
  assert.equal(writes, 1);
});

test('recovery cannot confirm or touch another proposal or claim actor', async () => {
  const provider = persistence(); let writes = 0;
  const claimed = { ...proposal, status: 'applying' as const, version: 2, decidedBy: 'u-jonas' };
  await assert.rejects(confirmDocumentProposalReceipt(provider, {
    get: () => ({ id: claimed.id, sourceId: claimed.sourceId, version: 2, by: 'u-farah' }),
    set: () => { writes += 1; },
  }, claimed), /does not confirm/);
  assert.equal(writes, 0);
});
