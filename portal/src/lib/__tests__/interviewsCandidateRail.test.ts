// The candidate profile's list rail (lib/interviewsCandidateRail.ts): roles, grouping, order, the open row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entriesFromCandidates, entriesFromOpenings, railKindFor, railMatches, railModel, railNames,
} from '../interviewsCandidateRail.ts';
import type { CandidateRow, OpeningRow } from '../interviews.ts';

const cand = (id: string, name: string, stage: string, opening = 'Backend Engineer') => ({
  applicationId: `app-${id}`, candidate: { id, name, headline: 'Engineer', location: '', source: '' },
  opening: { id: 'op', title: opening, team: 'Platform' }, stage,
} as unknown as CandidateRow);

test('a recruiter and an admin read every candidate, a hiring manager their openings, an interviewer no rail', () => {
  assert.equal(railKindFor('recruiter'), 'candidates');
  assert.equal(railKindFor('admin'), 'candidates');
  assert.equal(railKindFor('hiring-manager'), 'openings');
  assert.equal(railKindFor('interviewer'), null);
  assert.equal(railKindFor(undefined), null);
  assert.equal(railNames('candidates').title, 'Candidates');
  assert.equal(railNames('openings').title, 'My openings');
});

test('the rows group by stage in the pipeline order, names A to Z inside, the opening as the subline', () => {
  const entries = entriesFromCandidates([
    cand('c3', 'Zed', 'offer'), cand('c1', 'Ingrid', 'interviewing'), cand('c2', 'Aiko', 'interviewing', 'Designer'), cand('c4', 'Mia', 'applied'),
  ]);
  const { groups, rows, total } = railModel(entries, '', null);
  assert.deepEqual(groups.map((g) => [g.id, g.count]), [['applied', 1], ['interviewing', 2], ['offer', 1]]);
  assert.deepEqual(rows.map((r) => r.title), ['Mia', 'Aiko', 'Ingrid', 'Zed']);
  assert.equal(rows[1]!.subline, 'Designer');
  assert.equal(rows[1]!.groupId, 'interviewing');
  assert.equal(total, 4);
});

test('a hiring manager’s entries come from the pipelines and a candidate on two openings shows once', () => {
  const entry = (id: string, name: string, stage: string) => ({ applicationId: id, candidate: { id, name, headline: 'H' }, stage });
  const openings = [
    { id: 'o1', title: 'Backend', pipeline: [entry('c1', 'Ingrid', 'screening'), entry('c2', 'Aiko', 'offer')] },
    { id: 'o2', title: 'Platform', pipeline: [entry('c1', 'Ingrid', 'interviewing')] },
  ] as unknown as OpeningRow[];
  const entries = entriesFromOpenings(openings);
  assert.deepEqual(entries.map((e) => [e.id, e.opening]), [['c1', 'Backend'], ['c2', 'Backend']]);
});

test('the find box matches every word over name, opening and stage, and never hides the open candidate', () => {
  const entries = entriesFromCandidates([cand('c1', 'Ingrid Solberg', 'interviewing'), cand('c2', 'Aiko Tanaka', 'applied', 'Designer')]);
  assert.equal(railMatches(entries[0]!, 'ingrid back'), true);
  assert.equal(railMatches(entries[0]!, 'designer'), false);
  assert.equal(railMatches(entries[1]!, 'applied designer'), true);
  assert.deepEqual(railModel(entries, 'designer', null).rows.map((r) => r.id), ['c2']);
  const kept = railModel(entries, 'designer', 'c1');
  assert.deepEqual(kept.rows.map((r) => r.id), ['c2', 'c1']);
  assert.equal(kept.rows.find((r) => r.id === 'c1')!.groupId, 'interviewing');
  assert.deepEqual(railModel([], '', null), { groups: [], rows: [], total: 0 });
});
