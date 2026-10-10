import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { assertSpeakingReview, hash, makeMediaContract } from './huddle-media-contract.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'work-huddle-contract-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const story = JSON.parse(readFileSync(join(root, 'docs/demos/work-huddles/storyboard.json'), 'utf8'));

test('the handoff contains all eight exact lines and unmodified portraits with only portable paths', () => {
  const out = join(temporary, 'bundle');
  const generated = spawnSync(process.execPath, [join(directory, 'export-huddle-handoff.mjs'), '--out', out], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const handoff = JSON.parse(readFileSync(join(out, 'requests.json'), 'utf8'));
  assert.equal(handoff.requests.length, 8);
  assert.equal(handoff.status, 'awaiting-speaking-mp4-exports');
  const expected = story.scenes.flatMap(scene => scene.turns);
  for (const request of handoff.requests) {
    assert.equal(request.speech, expected.find(turn => turn.id === request.id).speech);
    assert.equal(readFileSync(join(out, request.speechFile), 'utf8'), request.speech + '\n');
    assert.equal(hash(readFileSync(join(out, request.portrait))), request.portraitSha256);
    assert.match(request.export, /^exports\/[a-z0-9-]+\.mp4$/);
    assert.ok(readFileSync(join(out, request.promptFile), 'utf8').includes(request.speech));
  }
});

test('unrelated verification notes do not invalidate the media contract; changed speech does', () => {
  const contract = makeMediaContract(story, root);
  const updated = structuredClone(story);
  updated.verification = { currentBlockers: [] };
  assert.equal(makeMediaContract(updated, root).contentSha256, contract.contentSha256);
  updated.scenes[0].turns[0].speech += ' Extra words.';
  assert.notEqual(makeMediaContract(updated, root).contentSha256, contract.contentSha256);
});

test('duplicate turn IDs and path traversal are rejected before exporting files', () => {
  const duplicate = structuredClone(story);
  duplicate.scenes[1].turns[0] = duplicate.scenes[0].turns[0];
  assert.throws(() => makeMediaContract(duplicate, root), /Invalid or duplicate turn/);
  const traversal = structuredClone(story);
  traversal.cast[0].portrait = '../outside.jpg';
  assert.throws(() => makeMediaContract(traversal, root), /Portrait must stay inside/);
});

test('a review result applies only to the inspected bytes, exact words, identity and lip sync', () => {
  const contract = makeMediaContract(story, root);
  const id = story.scenes[0].turns[0].id;
  const file = join(temporary, 'reviewed-fixture.bin');
  writeFileSync(file, 'technical fixture only; not actual speaking video');
  const sources = new Map([[id, { file }]]);
  const review = { kind: 'speaking-media-review', contentSha256: contract.contentSha256,
    clips: [{ id, clipSha256: hash(readFileSync(file)), exactSpeech: null, matchingIdentity: null, lipSync: null, evidence: '' }] };
  assert.throws(() => assertSpeakingReview(review, contract, sources), /review is incomplete/);
  // These assertions exercise receipt matching, not a claim this fixture says a line.
  Object.assign(review.clips[0], { exactSpeech: true, matchingIdentity: true, lipSync: true, evidence: 'Test receipt-matching branch only.' });
  assert.doesNotThrow(() => assertSpeakingReview(review, contract, sources));
  writeFileSync(file, 'changed bytes');
  assert.throws(() => assertSpeakingReview(review, contract, sources), /changed after review/);
});
