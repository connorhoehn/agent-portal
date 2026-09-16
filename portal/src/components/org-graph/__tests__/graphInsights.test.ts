// Run with:  cd portal && node --test 'src/components/org-graph/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  orgInsight,
  rareSkillFindingsUrl,
  RARE_SKILL_SWEEP,
  nodeRadius,
  degreeMap,
  maxDegree,
  parseFocusIds,
} from '../graphInsights.ts';
import type { GraphPerson } from '../types.ts';

function person(id: string, department: string, skills: string[]): GraphPerson {
  return { id, name: `Person ${id}`, title: 'Engineer', department, skills, influenceScore: 0.5 };
}

// ── orgInsight ────────────────────────────────────────────────────────────

test('orgInsight lists a skill held by exactly the rare threshold (2)', () => {
  const people = [
    person('p1', 'Eng', ['Rust']),
    person('p2', 'Design', ['Rust']),
    person('p3', 'Eng', ['TypeScript']),
    person('p4', 'Design', ['TypeScript']),
    person('p5', 'Eng', ['TypeScript']),
  ];
  const { atRisk } = orgInsight(people);
  const rustEntries = atRisk.filter((a) => a.skill === 'Rust');
  assert.equal(rustEntries.length, 2, 'both Rust holders get their own entry');
  assert.deepEqual(new Set(rustEntries.map((e) => e.holder.id)), new Set(['p1', 'p2']));
  assert.ok(atRisk.every((a) => a.skill !== 'TypeScript'), 'a 3-holder skill is not rare');
});

test('orgInsight is not scoped to a department — unlike departmentInsight', () => {
  // A skill whose two holders sit in different departments still shows both:
  // there is no department filter to drop one of them.
  const people = [person('p1', 'Eng', ['Coq']), person('p2', 'Ops', ['Coq'])];
  const { atRisk } = orgInsight(people);
  assert.equal(atRisk.length, 2);
  assert.deepEqual(new Set(atRisk.map((a) => a.holder.department)), new Set(['Eng', 'Ops']));
});

test('orgInsight excludes a skill above the rare threshold', () => {
  const people = [
    person('p1', 'Eng', ['SQL']),
    person('p2', 'Eng', ['SQL']),
    person('p3', 'Eng', ['SQL']),
  ];
  const { atRisk } = orgInsight(people);
  assert.equal(atRisk.filter((a) => a.skill === 'SQL').length, 0);
});

test('orgInsight on an empty roster returns no at-risk skills', () => {
  assert.deepEqual(orgInsight([]).atRisk, []);
});

test('orgInsight reports the correct holderCount alongside every holder entry', () => {
  const people = [person('p1', 'Eng', ['Erlang'])];
  const { atRisk } = orgInsight(people);
  assert.equal(atRisk.length, 1);
  assert.equal(atRisk[0].holderCount, 1);
  assert.equal(atRisk[0].holder.id, 'p1');
});

// ── rareSkillFindingsUrl ─────────────────────────────────────────────────────

test('rareSkillFindingsUrl points at the bus-factor sweep with the skill as the query', () => {
  const url = rareSkillFindingsUrl('Kubernetes');
  assert.match(url, /^\/iq\/work\/findings\?/);
  const params = new URLSearchParams(url.split('?')[1]);
  assert.equal(params.get('sweep'), RARE_SKILL_SWEEP);
  assert.equal(params.get('q'), 'Kubernetes');
});

test('rareSkillFindingsUrl encodes a skill name with special characters', () => {
  const url = rareSkillFindingsUrl('C++/CLI');
  const params = new URLSearchParams(url.split('?')[1]);
  assert.equal(params.get('q'), 'C++/CLI');
});

// ── nodeRadius ────────────────────────────────────────────────────────────

test('nodeRadius sizes by influence when showInfluence is true, ignoring degree', () => {
  const r0 = nodeRadius(true, 0, 5, 10);
  const r1 = nodeRadius(true, 1, 0, 10);
  assert.equal(r0, 12); // MIN_RADIUS
  assert.equal(r1, 30); // MIN_RADIUS + RADIUS_RANGE
});

test('nodeRadius sizes by degree relative to maxDegree when showInfluence is false', () => {
  // Same influenceScore, different degree — the two must NOT match, or
  // influence is still leaking through.
  const highInfluenceLowDegree = nodeRadius(false, 0.95, 1, 10);
  const lowInfluenceHighDegree = nodeRadius(false, 0.05, 10, 10);
  assert.equal(highInfluenceLowDegree, 12 + (1 / 10) * 18);
  assert.equal(lowInfluenceHighDegree, 12 + 18); // at the max
  assert.ok(lowInfluenceHighDegree > highInfluenceLowDegree);
});

test('nodeRadius ignores influenceScore entirely when showInfluence is false', () => {
  const a = nodeRadius(false, 0.99, 3, 6);
  const b = nodeRadius(false, 0.01, 3, 6);
  assert.equal(a, b, 'two nodes with equal degree must draw at equal size regardless of influence');
});

test('nodeRadius with maxDegree 0 (edgeless graph) draws every node at the minimum', () => {
  assert.equal(nodeRadius(false, 0.8, 0, 0), 12);
});

test('nodeRadius clamps an out-of-range influenceScore instead of drawing an absurd circle', () => {
  assert.equal(nodeRadius(true, 5, 0, 0), 30); // clamped to 1
  assert.equal(nodeRadius(true, -1, 0, 0), 12); // clamped to 0
});

// ── degreeMap / maxDegree ────────────────────────────────────────────────────

test('degreeMap counts each endpoint of every link', () => {
  const links = [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'c' },
    { source: 'b', target: 'c' },
  ];
  const m = degreeMap(links);
  assert.equal(m.get('a'), 2);
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 2);
});

test('degreeMap counts a self-loop once, not twice', () => {
  const m = degreeMap([{ source: 'a', target: 'a' }]);
  assert.equal(m.get('a'), 1);
});

test('degreeMap on no links is empty, and maxDegree of that is 0', () => {
  const m = degreeMap([]);
  assert.equal(m.size, 0);
  assert.equal(maxDegree(m), 0);
});

test('maxDegree finds the largest value in the map', () => {
  const links = [
    { source: 'hub', target: 'a' },
    { source: 'hub', target: 'b' },
    { source: 'hub', target: 'c' },
    { source: 'a', target: 'b' },
  ];
  assert.equal(maxDegree(degreeMap(links)), 3); // hub touches 3 links
});

// ── parseFocusIds ────────────────────────────────────────────────────────────

test('parseFocusIds parses a single id (the /search related-people card shape)', () => {
  assert.deepEqual(parseFocusIds('p-007'), ['p-007']);
});

test('parseFocusIds parses a comma-joined list (the Ask "Open in Ask" round-trip)', () => {
  assert.deepEqual(parseFocusIds('p-001,p-002,p-003'), ['p-001', 'p-002', 'p-003']);
});

test('parseFocusIds trims whitespace and drops empty segments', () => {
  assert.deepEqual(parseFocusIds(' p-001 , p-002,,p-003 '), ['p-001', 'p-002', 'p-003']);
});

test('parseFocusIds on null or empty string returns no ids, not [""]', () => {
  assert.deepEqual(parseFocusIds(null), []);
  assert.deepEqual(parseFocusIds(''), []);
  assert.deepEqual(parseFocusIds(','), []);
});
