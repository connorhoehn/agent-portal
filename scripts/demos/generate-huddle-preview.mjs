#!/usr/bin/env node
// Offline rehearsal placeholder: photographic stills with local synthesized
// speech. This is explicitly NOT generated webcam footage or lip-sync video.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[at + 1];
};
const run = (command, argv) => {
  const result = spawnSync(command, argv, { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
};

try {
  if (process.platform !== 'darwin') throw new Error('This offline preview uses macOS say. Supply real speaking MP4s to prepare-huddle-media.mjs on other systems.');
  const out = resolve(option('--out', '/private/tmp/work-huddle-preview-clips'));
  const story = JSON.parse(readFileSync(resolve(option('--storyboard', join(root, 'docs/demos/work-huddles/storyboard.json'))), 'utf8'));
  const voices = { 'u-vera': option('--vera-voice', 'Samantha'), 'u-nora': option('--nora-voice', 'Karen') };
  mkdirSync(out, { recursive: true });
  const generated = [];
  for (const scene of story.scenes) for (const turn of scene.turns) {
    if (!/^[a-z][a-z0-9-]{0,70}$/.test(turn.id) || turn.clip !== `${turn.id}.mp4` || typeof turn.speech !== 'string' || !turn.speech.trim()) throw new Error('Invalid storyboard turn');
    const actor = story.cast.find(person => person.userId === turn.actor);
    const voice = voices[turn.actor];
    if (!actor || !voice) throw new Error(`No preview voice for ${turn.actor}`);
    const portrait = resolve(root, actor.portrait);
    if (!existsSync(portrait)) throw new Error(`Missing portrait: ${portrait}`);
    const text = join(out, `${turn.id}.txt`), speech = join(out, `${turn.id}.aiff`), clip = join(out, turn.clip);
    writeFileSync(text, turn.speech + '\n');
    run('/usr/bin/say', ['-v', voice, '-r', '165', '-f', text, '-o', speech]);
    const spoken = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', speech]));
    const seconds = Number(spoken.format?.duration);
    if (!spoken.streams.some(stream => stream.codec_type === 'audio') || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120) {
      throw new Error(`The local voice ${voice} did not produce usable speech. Install or enable that voice outside this script, or supply a speaking MP4 export.`);
    }
    run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', portrait, '-i', speech,
      '-vf', 'scale=480:270:force_original_aspect_ratio=increase,crop=480:270',
      '-r', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', String(seconds), '-shortest', '-movflags', '+faststart',
      '-metadata', 'title=Rehearsal preview - still portrait and synthesized speech', '-metadata', 'comment=Offline preview. No facial animation, lip sync, or voice cloning.', clip]);
    const info = JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', clip]));
    if (!info.streams.some(stream => stream.codec_type === 'audio') || !info.streams.some(stream => stream.codec_type === 'video')) throw new Error(`Incomplete preview: ${clip}`);
    generated.push({ id: turn.id, actor: turn.actor, voice, speech: turn.speech, clip, seconds: Number(info.format.duration) });
    console.log(`Prepared ${turn.id}: ${Number(info.format.duration).toFixed(1)}s`);
  }
  writeFileSync(join(out, 'preview-manifest.json'), JSON.stringify({ kind: 'offline-rehearsal-preview', video: 'Static photographic portraits; no facial animation or lip sync.', audio: 'Local macOS synthesized speech; no voice cloning.', generated }, null, 2) + '\n');
  console.log(`Ready: ${generated.length} preview clips. Use prepare-huddle-media.mjs --clips ${out} to assemble the synchronized rehearsal.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
