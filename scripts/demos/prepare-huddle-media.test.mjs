import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const temporary = mkdtempSync(join(tmpdir(), 'work-speaking-audio-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const story = JSON.parse(readFileSync(join(root, 'docs/demos/work-huddles/storyboard.json'), 'utf8'));
const turn = story.scenes[0].turns[0];
const storyboard = join(temporary, 'storyboard.json');
writeFileSync(storyboard, JSON.stringify({ ...story, scenes: [{ ...story.scenes[0], turns: [turn] }] }));

function validate(audio, name) {
  const clips = join(temporary, name);
  mkdirSync(clips);
  const encoded = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=gray:s=480x270:r=12', '-f', 'lavfi', '-i', audio,
    '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(clips, turn.clip)], { encoding: 'utf8' });
  assert.equal(encoded.status, 0, encoded.error?.message ?? encoded.stderr);
  return spawnSync(process.execPath, [join(directory, 'prepare-huddle-media.mjs'),
    '--storyboard', storyboard, '--clips', clips, '--validate'], { encoding: 'utf8' });
}

test('media preflight rejects a silent MP4 even when it has an audio stream', () => {
  const result = validate('anullsrc=r=48000:cl=mono', 'silent');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Speaking audio is silent or too quiet/);
});

test('media preflight accepts a video with a measurable audio signal', () => {
  const result = validate('sine=frequency=440:sample_rate=48000', 'audible');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Technical checks passed: 1 clips, 2 actors, 1 scenes/);
  assert.match(result.stdout, /Speaking review: unverified/);
});

test('the assembler aligns both actors and keeps test tones explicitly unreviewed', () => {
  const clips = join(temporary, 'assembly-clips'), out = join(temporary, 'assembly-out');
  mkdirSync(clips);
  const second = story.scenes[0].turns[1];
  const scene = { ...story.scenes[0], startHoldSeconds: 0.25,
    turns: [turn, second].map(item => ({ ...item, holdAfterSeconds: 0.25 })) };
  const shortStory = join(temporary, 'assembly-story.json');
  writeFileSync(shortStory, JSON.stringify({ ...story, scenes: [scene] }));
  for (const [index, item] of scene.turns.entries()) {
    const encoded = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=gray:s=480x270:r=12', '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:sample_rate=48000`,
      '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(clips, item.clip)], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.stderr);
  }
  const assembled = spawnSync(process.execPath, [join(directory, 'prepare-huddle-media.mjs'),
    '--storyboard', shortStory, '--clips', clips, '--out', out], { encoding: 'utf8' });
  assert.equal(assembled.status, 0, assembled.stderr);
  const schedule = JSON.parse(readFileSync(join(out, scene.id, 'timeline.json'), 'utf8'));
  const verification = JSON.parse(readFileSync(join(out, 'media-verification.json'), 'utf8'));
  assert.equal(verification.speakingReview, 'unverified');
  assert.equal(schedule.speakingReview, 'unverified');
  assert.equal(schedule.durationSeconds, 1.75);
  assert.deepEqual(schedule.timeline.map(item => item.atSeconds), [0.25, 1]);
  for (const actor of story.cast) {
    const wav = join(out, scene.id, `${actor.userId}.wav`);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', wav], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const info = JSON.parse(probe.stdout);
    assert.equal(Number(info.format.duration), schedule.durationSeconds);
    assert.equal(info.streams[0].sample_rate, '48000');
    const camera = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', join(out, scene.id, `${actor.userId}.y4m`)], { encoding: 'utf8' });
    assert.equal(camera.status, 0, camera.stderr);
    assert.equal(Number(JSON.parse(camera.stdout).streams[0].nb_read_frames), 21);
    const audio = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', wav, '-f', 'f32le', '-'], { maxBuffer: 2 * 1024 * 1024 });
    assert.equal(audio.status, 0, audio.stderr?.toString());
    const rmsAt = seconds => {
      const start = Math.round(seconds * 48000), count = 2400;
      let sum = 0;
      for (let i = start; i < start + count; i++) sum += audio.stdout.readFloatLE(i * 4) ** 2;
      return Math.sqrt(sum / count);
    };
    assert.ok(rmsAt(actor.userId === turn.actor ? 0.4 : 1.2) > 0.02, `${actor.userId} must be audible during its own turn`);
    assert.ok(rmsAt(actor.userId === turn.actor ? 1.2 : 0.4) < 0.001, `${actor.userId} must stay silent during the other actor's turn`);
  }
});
