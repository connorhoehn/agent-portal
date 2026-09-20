import assert from 'node:assert/strict';
import test from 'node:test';
import { documentCanvasSaveState, canEditDocumentCanvas } from '../knowledge/documentCanvasState.ts';

test('initial sync is not a durable save receipt', () => {
  assert.equal(documentCanvasSaveState('idle', 0, true, () => {}), undefined);
  assert.equal(documentCanvasSaveState('pending', 1, true, () => {})?.status, 'pending');
  assert.equal(documentCanvasSaveState('saved', 0, true, () => {})?.status, 'saved');
});
test('pending offline changes and failed writes are visible and retryable', () => {
  const retry = () => {};
  assert.deepEqual(documentCanvasSaveState('pending', 1, false, retry), { status: 'offline', onRetry: retry });
  assert.deepEqual(documentCanvasSaveState('error', 1, true, retry), { status: 'error', onRetry: retry });
});
test('source prompts, expired grants and refused refreshes cannot enable editing', () => {
  const grant = { canEdit: true, expiresAt: 200 };
  assert.equal(canEditDocumentCanvas(grant, 'workspace', true, 100), true);
  assert.equal(canEditDocumentCanvas(grant, 'prompts', true, 100), false);
  assert.equal(canEditDocumentCanvas(grant, 'workspace', true, 200), false);
  assert.equal(canEditDocumentCanvas(grant, 'workspace', false, 100), false);
  assert.equal(canEditDocumentCanvas({ ...grant, canEdit: false }, 'workspace', true, 100), false);
});
