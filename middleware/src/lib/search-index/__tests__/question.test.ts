import { parseQuestion, type QuestionVocab } from '../question.js';

const vocab: QuestionVocab = {
  skills: ['Kubernetes', 'Terraform', 'RAG', 'Observability', 'Go', 'AWS Security'],
  teams: [{ id: 't-platform', name: 'Platform Engineering' }, { id: 't-data', name: 'Data Platform' }],
  people: [{ id: 'p-004', name: 'Nora DaSilva' }, { id: 'p-051', name: 'Simone Chang' }, { id: 'p-032', name: 'Nora Foster' }],
  initiatives: [{ id: 'p-auth-migration', name: 'Auth Migration' }, { id: 'p-observability', name: 'Observability Platform' }],
};
const kinds = (q: string) => parseQuestion(q, vocab).intents.map(i => i.kind);

test.each([
  ['who knows Kubernetes', 'experts'], ['find someone who can help with k8s', 'experts'], ['Terraform skills', 'experts'],
  ['strongest retrieval-augmented generation people', 'experts'], ['best person for terraform modules', 'experts'],
  ['who is on the platform team', 'team'], ['Platform Engineering people', 'team'], ['members of team platform', 'team'],
  ['people who worked with Nora', 'collaborators'], ['Nora DaSilva collaborators', 'collaborators'],
  ['who decided on self-hosted OTel collectors', 'decider'], ['decider for OTel collectors over vendor agents', 'decider'],
  ['which decisions are still open', 'decisions'], ['escalated decisions', 'decisions'],
  ['what am I working on', 'my-work'], ['work assigned to me', 'my-work'],
  ['who can help finish Auth Migration?', 'initiative-people'], ['auth migration experts', 'initiative-people'],
  ['what changed on Observability Platform', 'recent'], ['Observability updates this week', 'recent'],
])('%s → %s', (q, kind) => { expect(kinds(q)[0]).toBe(kind); });

test.each(['Kubernetes', 'Observability', 'Aurora cold start', 'how do I warm the Aurora Data API after idle', 'top', 'Go'])('%s is a plain search, no intent', (q) => {
  expect(kinds(q)).toEqual([]);
  expect(parseQuestion(q, vocab).terms.length).toBeGreaterThan(0);
});

test('synonyms and scaffolding: k8s searches Kubernetes, not "someone"', () => {
  expect(parseQuestion('find someone who can help with k8s', vocab).terms).toEqual(['kubernetes']);
  // "identity and access" is the IAM skill (the demo's closing question).
  const iam = parseQuestion('Who knows identity and access?', { ...vocab, skills: [...vocab.skills, 'IAM'] });
  expect(iam.intents[0]).toEqual({ kind: 'experts', skills: ['IAM'] });
  expect(parseQuestion('which decisions are still open', vocab).terms).toEqual([]);
  expect(parseQuestion('escalated decisions', vocab).intents[0]).toEqual({ kind: 'decisions', statuses: ['escalated'] });
});

test('"my" binds to the signed-in person, and an ambiguous first name names every match', () => {
  expect(parseQuestion('my open work items', vocab).mine).toBe(true);
  const collab = parseQuestion('people who worked with Nora', vocab).intents[0];
  expect(collab).toEqual({ kind: 'collaborators', people: [{ id: 'p-004', name: 'Nora DaSilva' }, { id: 'p-032', name: 'Nora Foster' }] });
});
