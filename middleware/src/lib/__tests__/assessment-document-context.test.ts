jest.mock('../../providers/assessment.js', () => ({ getKnowledgeDoc: jest.fn(), getKnowledgeTree: jest.fn() }));
import { getKnowledgeDoc, getKnowledgeTree } from '../../providers/assessment.js';
import { assessmentDocumentLobby, assessmentDocumentRecordingHost, assessmentSourceFromCallChannel, isDocumentSourceId } from '../assessment-document-context.js';
const sourceId = 'ec:standards/ci-cd-standards.md';
const doc = { id: sourceId, title: 'CI/CD Standards', classification: 'internal', markdown: '', editable: true, path: sourceId, updated_at: '' };
const node = { id: sourceId, title: doc.title, is_dir: false, parent_id: null };
beforeEach(() => { jest.mocked(getKnowledgeDoc).mockReset().mockResolvedValue(doc); jest.mocked(getKnowledgeTree).mockReset().mockResolvedValue({ sections: [] }); });
test('uses exact original UTF-16 source hash and retains eligible plain identifiers', () => {
  expect(assessmentDocumentLobby('page:100002')).toBe('assessment:doc:page:100002');
  expect(assessmentDocumentLobby(sourceId)).toMatch(/^assessment:doc:h:[a-z0-9]+$/);
  expect(assessmentDocumentLobby(sourceId)).not.toBe(assessmentDocumentLobby(`${sourceId}-other`));
  expect(assessmentDocumentLobby('a'.repeat(100)).length).toBeLessThanOrEqual(50);
  expect(isDocumentSourceId('page:\u0000bad')).toBe(false);
  expect(isDocumentSourceId('a'.repeat(1025))).toBe(false);
});
test.each(['workspace', 'enterprise', 'rules', 'prompts'])('strict supported %s call channel extracts original ID', path => {
  expect(assessmentSourceFromCallChannel(`assessment-document:/assessment/${path}?doc=${encodeURIComponent(sourceId)}`)).toBe(sourceId);
});
test.each(['https://other.invalid/assessment/workspace?doc=x', '/assessment/workspace?doc=x&doc=y', '/assessment/workspace?doc=x&recording=y', '/assessment/teams?doc=x', '/assessment/workspace?doc=x#other', '/assessment/workspace?doc=%00', '/assessment/workspace?doc='])('rejects malformed/foreign call href %s', href => {
  expect(assessmentSourceFromCallChannel(`assessment-document:${href}`)).toBeNull();
});
test.each([['enterprise_context', 'local', 'enterprise'], ['rules', 'local', 'rules'], ['prompts', 'local', 'prompts'], ['workspace_drafts', 'local', 'workspace'], ['confluence-eng', 'synced', 'workspace']])('navigation derives %s from actual authoritative section', async (key, kind, path) => {
  jest.mocked(getKnowledgeTree).mockResolvedValue({ sections: [{ key, kind: kind as 'local' | 'synced', title: key, nodes: [node] }] });
  expect(await assessmentDocumentRecordingHost(sourceId, assessmentDocumentLobby(sourceId))).toEqual({ title: doc.title, href: `/assessment/${path}?doc=${encodeURIComponent(sourceId)}` });
});
test('missing/mismatched/deleted/hidden/ambiguous source never invents a document destination', async () => {
  expect(await assessmentDocumentRecordingHost(sourceId, 'assessment:doc:wrong')).toBeNull();
  expect(getKnowledgeDoc).not.toHaveBeenCalled();
  jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
  expect(await assessmentDocumentRecordingHost(sourceId, assessmentDocumentLobby(sourceId))).toBeNull();
  for (const nodes of [[{ ...node, viewable: false }], [{ ...node, is_dir: true }], []]) {
    jest.mocked(getKnowledgeTree).mockResolvedValue({ sections: [{ key: 'rules', kind: 'local', title: 'Rules', nodes }] });
    expect(await assessmentDocumentRecordingHost(sourceId, assessmentDocumentLobby(sourceId))).toBeNull();
  }
  jest.mocked(getKnowledgeTree).mockResolvedValue({ sections: ['rules', 'prompts'].map(key => ({ key, kind: 'local', title: key, nodes: [node] })) });
  expect(await assessmentDocumentRecordingHost(sourceId, assessmentDocumentLobby(sourceId))).toBeNull();
});
