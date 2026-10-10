// The generation handoff and the media assembler share this exact content
// contract. Demo verification notes are deliberately outside the fingerprint.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const safeId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,70}$/.test(value);

export function makeMediaContract(story, root) {
  if (!Array.isArray(story.cast) || story.cast.length < 2
    || story.cast.some(actor => !safeId(actor.userId))
    || new Set(story.cast.map(actor => actor.userId)).size !== story.cast.length) {
    throw new Error('The storyboard needs at least two distinct safe actor IDs.');
  }
  const cast = story.cast.map(actor => {
    if (typeof actor.portrait !== 'string' || !actor.portrait.trim()) throw new Error(`Missing portrait for ${actor.userId}`);
    const portraitPath = resolve(root, actor.portrait);
    const inside = relative(root, portraitPath);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('../')) throw new Error(`Portrait must stay inside the repository: ${actor.userId}`);
    return {
      userId: actor.userId, subjectId: actor.subjectId, name: actor.name, role: actor.role,
      portrait: `portraits/${actor.userId}.jpg`, portraitSha256: hash(readFileSync(portraitPath)),
      voiceDirection: actor.voiceDirection,
    };
  });
  if (!Array.isArray(story.scenes) || !story.scenes.length) throw new Error('The storyboard needs scenes.');
  const ids = new Set();
  const sceneIds = new Set();
  const scenes = story.scenes.map(scene => {
    if (!safeId(scene.id) || sceneIds.has(scene.id)
      || !Number.isFinite(scene.startHoldSeconds) || scene.startHoldSeconds < 0 || scene.startHoldSeconds > 300
      || !Array.isArray(scene.turns) || !scene.turns.length) throw new Error(`Invalid scene: ${scene.id}`);
    sceneIds.add(scene.id);
    return {
      id: scene.id, startHoldSeconds: scene.startHoldSeconds,
      turns: scene.turns.map(turn => {
        if (!safeId(turn.id) || ids.has(turn.id) || !cast.some(actor => actor.userId === turn.actor)
          || turn.clip !== `${turn.id}.mp4` || typeof turn.speech !== 'string' || !turn.speech.trim()
          || !Number.isFinite(turn.holdAfterSeconds) || turn.holdAfterSeconds < 0 || turn.holdAfterSeconds > 300) {
          throw new Error(`Invalid or duplicate turn: ${turn.id}`);
        }
        ids.add(turn.id);
        return {
          id: turn.id, actor: turn.actor, clip: turn.clip, speech: turn.speech,
          action: turn.action, holdAfterSeconds: turn.holdAfterSeconds,
        };
      }),
    };
  });
  const content = { version: 1, direction: story.clipDirection, cast, scenes };
  return { ...content, contentSha256: hash(JSON.stringify(content)) };
}

export function assertSpeakingReview(review, contract, sources) {
  if (review?.kind !== 'speaking-media-review' || review.contentSha256 !== contract.contentSha256
    || !Array.isArray(review.clips)) throw new Error('Speaking review does not match the current lines, portraits and timing. Regenerate the handoff and review the changed content.');
  for (const [id, source] of sources) {
    const rows = review.clips.filter(row => row.id === id);
    if (rows.length !== 1) throw new Error(`Speaking review needs one result for ${id}`);
    const result = rows[0];
    if (result.clipSha256 !== hash(readFileSync(source.file))) throw new Error(`Speaking clip changed after review: ${id}`);
    if (result.exactSpeech !== true || result.matchingIdentity !== true || result.lipSync !== true
      || typeof result.evidence !== 'string' || !result.evidence.trim()) {
      throw new Error(`Speaking review is incomplete for ${id}: watch and listen for exact words, matching identity and lip sync, and record the evidence.`);
    }
  }
}
