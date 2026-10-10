#!/usr/bin/env node
// Portable exact-speech requests and original portraits. No generation, upload,
// account changes or network requests occur here.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMediaContract } from './huddle-media-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const at = args.indexOf(key);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${key} needs a value`);
  return args[at + 1];
};

try {
  const storyboard = resolve(option('--storyboard', join(root, 'docs/demos/work-huddles/storyboard.json')));
  const out = resolve(option('--out', join(root, 'docs/demos/work-huddles/media-handoff')));
  const story = JSON.parse(readFileSync(storyboard, 'utf8'));
  const contract = makeMediaContract(story, root);
  for (const folder of ['', 'portraits', 'speech', 'prompts', 'exports']) mkdirSync(join(out, folder), { recursive: true });
  for (const actor of story.cast) copyFileSync(resolve(root, actor.portrait), join(out, `portraits/${actor.userId}.jpg`));
  const requests = contract.scenes.flatMap(scene => scene.turns.map(turn => {
    const actor = contract.cast.find(person => person.userId === turn.actor);
    const prompt = `${contract.direction}\n\nCharacter: ${actor.name}. Reference image: ${actor.portrait}.\nVoice: ${actor.voiceDirection}. Keep this actor's voice consistent across all four clips.\n\nSay exactly this line, without adding an introduction or changing the wording:\n${turn.speech}\n\nExport only this turn, including its audible spoken line, as ${turn.clip}. Do not bake in the later scene holds; the assembler adds them.\n`;
    const speechFile = `speech/${turn.id}.txt`, promptFile = `prompts/${turn.id}.txt`;
    writeFileSync(join(out, speechFile), turn.speech + '\n');
    writeFileSync(join(out, promptFile), prompt);
    return { id: turn.id, scene: scene.id, actor: turn.actor, actorName: actor.name, portrait: actor.portrait,
      portraitSha256: actor.portraitSha256, voiceDirection: actor.voiceDirection,
      speech: turn.speech, speechFile, promptFile, export: `exports/${turn.clip}` };
  }));
  const manifest = {
    kind: 'speaking-media-generation-handoff', version: 1, status: 'awaiting-speaking-mp4-exports',
    contentSha256: contract.contentSha256, contract,
    output: { format: 'MP4 with video and audible speech', suggestedWidth: 1280, suggestedHeight: 720,
      captions: false, watermark: false, maximumClipSeconds: 120, minimumAudioPeakDbFS: -55 },
    requests,
  };
  writeFileSync(join(out, 'requests.json'), JSON.stringify(manifest, null, 2) + '\n');
  const review = { kind: 'speaking-media-review', contentSha256: contract.contentSha256,
    clips: requests.map(request => ({ id: request.id, clipSha256: null, exactSpeech: null,
      matchingIdentity: null, lipSync: null, evidence: '' })) };
  writeFileSync(join(out, 'review-template.json'), JSON.stringify(review, null, 2) + '\n');
  writeFileSync(join(out, 'exports/.gitkeep'), '');
  writeFileSync(join(out, 'HANDOFF.md'), `# Speaking-media handoff\n\nThis bundle contains ${requests.length} exact-line requests and ${contract.cast.length} original reference portraits. It does not contain generated speaking clips. The exports directory is intentionally empty.\n\nKeep one stable voice per actor. Use each request's matching portrait and its speech file without paraphrasing. Prompts are provider-neutral; no account, model or voice ID has been invented.\n\n1. Generate one audible webcam-style MP4 per request. Save it under the exact filename in exports/.\n2. Watch and listen to every clip. Confirm the exact words, matching portrait identity, realistic facial movement and lip sync; exclude title cards, captions and watermarks. Record the clip's SHA-256 and findings in a copy of review-template.json. Use null for unverified checks rather than true.\n3. Run the technical preflight from the repository: node scripts/demos/prepare-huddle-media.mjs --clips /absolute/path/to/exports --validate\n4. Assemble the reviewed scene inputs: node scripts/demos/prepare-huddle-media.mjs --clips /absolute/path/to/exports --review /absolute/path/to/review.json --out /private/tmp/work-huddle-media\n\nThe review is verification evidence, not a permission request. The agent can populate it after inspecting the actual exported clips. A matching receipt proves that the reviewed bytes were used; it does not replace that inspection. Changed speech, portraits or clip bytes invalidate it.\n\nAssembly adds each opening hold and action hold from the storyboard, uses still portraits while the other actor speaks, and outputs separate MP4, Y4M camera and WAV microphone files plus timeline.json for each scene. Those idle portraits are not generated listening footage. No transcript or recorded call is fabricated by this bundle.\n\nChromium fake capture begins when preview requests its device, before Join. Open the two device checks together and verify the first lines align within the opening hold; this handoff cannot claim live synchronization before that check passes. The scene timeline is a rehearsal schedule, not automation of the UI actions.\n`);
  console.log(`Prepared ${requests.length} exact-line requests and ${contract.cast.length} portraits: ${out}\nSpeaking clips remain ungenerated.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
