// The candidate's own live captions on the page (guestCaptionLines.ts): when the area shows, the words for who spoke, the merge by
// seq, the bound, and what a screen reader is told.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTIONS_DECLINED, CAPTIONS_KEPT, CAPTIONS_POLL_MS, captionAnnouncement, captionSpeakerLabel, captionsMaxReads, captionsMode, mergeCaptions,
  type CaptionLine,
} from '../guestCaptionLines.ts';

const l = (seq: number, speaker: CaptionLine['speaker'], text: string): CaptionLine => ({ seq, speaker, text });

test('the area: nothing where captions are not offered or the answer is unknown; one sentence when the transcript was declined', () => {
  assert.equal(captionsMode(undefined, true), 'none');
  assert.equal(captionsMode(false, true), 'none');
  assert.equal(captionsMode(true, null), 'none');
  assert.equal(captionsMode(true, false), 'declined');
  assert.equal(captionsMode(true, true), 'captions');
  // One plain sentence, the reason, and no ask to change the answer.
  assert.equal(CAPTIONS_DECLINED.split('. ').length, 1);
  assert.doesNotMatch(CAPTIONS_DECLINED, /change|turn on|you can|should|please/i);
});

test('who spoke is a word: You, Interviewer or Milo; anything else reads as the panel, never as the candidate', () => {
  assert.deepEqual(['you', 'interviewer', 'milo', 'u-hugo'].map(captionSpeakerLabel), ['You', 'Interviewer', 'Milo', 'Interviewer']);
});

test('new lines merge by seq, oldest first, without repeats, and at most CAPTIONS_KEPT stay', () => {
  const held = [l(1, 'interviewer', 'Hello.'), l(2, 'you', 'Hi.')];
  assert.deepEqual(mergeCaptions(held, [l(2, 'you', 'Hi.'), l(3, 'milo', 'Ten minutes left.')]).map((x) => x.seq), [1, 2, 3]);
  const many = Array.from({ length: CAPTIONS_KEPT + 5 }, (_, i) => l(i + 1, 'interviewer', `line ${i + 1}`));
  const kept = mergeCaptions([], many);
  assert.equal(kept.length, CAPTIONS_KEPT);
  assert.equal(kept[0]!.seq, 6);
  // A line keeps only its three keys, whatever else arrives with it.
  const extra = mergeCaptions([], [{ ...l(9, 'you', 'x'), userId: 'guest:inv-1' } as CaptionLine]);
  assert.deepEqual(Object.keys(extra[0]!).sort(), ['seq', 'speaker', 'text']);
});

test('a screen reader hears who and the words of the newest line; nothing when there is none', () => {
  assert.equal(captionAnnouncement(l(4, 'interviewer', 'Tell me about a hard bug.')), 'Interviewer: Tell me about a hard bug.');
  assert.equal(captionAnnouncement(l(5, 'you', '<b>markup</b> stays text')), 'You: <b>markup</b> stays text');
  assert.equal(captionAnnouncement(undefined), '');
});

test('the reads are bounded by the round and half an hour, inside the route\'s 60 a minute', () => {
  assert.equal(captionsMaxReads(30), Math.ceil((60 * 60_000) / CAPTIONS_POLL_MS));
  assert.equal(captionsMaxReads(Number.NaN), captionsMaxReads(60));
  assert.ok(60_000 / CAPTIONS_POLL_MS <= 60);
});
