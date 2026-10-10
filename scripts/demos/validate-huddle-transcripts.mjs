#!/usr/bin/env node
// Read-only content gate for the existing native recording/TranscriptDoc path.
// A ready or HTTP-200 transcript with no speech cannot pass this gate.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const nativeRead = String.raw`
const {callRecordingRepo,pipelineRunRepo}=require('/app/dist/repositories');
const id=process.argv[1];
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const safeError=value=>typeof value==='string'?value.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/([?&](?:token|sig|signature|key)=)[^&\s]+/gi,'$1[redacted]').slice(0,500):undefined;
(async()=>{
  const row=await callRecordingRepo.findByRecordingId(id);
  if(!row)throw new Error('Recording not found in the existing native store');
  const recording={...pick(row,['recordingId','callId','sessionId','lobbyName','startedAt','endedAt','durationMs','composeStatus','transcriptStatus','summaryStatus','participantCount']),
    participants:(row.participants??[]).map(p=>pick(p,['userId','displayName','participantId'])),composedBytes:row.composedSegment?.size,transcriptError:safeError(row.transcriptError)};
  const pipelines=[];
  for(const pipelineId of ['recording-finalize','call-transcription']){
    for(const run of await pipelineRunRepo.listByPipeline(pipelineId,{limit:200})){
      if(run.checkpoint?.context?.recordingId!==id)continue;
      pipelines.push({...pick(run,['pipelineId','runId','status','startedAt','completedAt']),error:safeError(run.error),
        steps:Object.entries(run.stepsSummary??{}).map(([id,step])=>({id,...pick(step,['status','durationMs','completedAt']),error:safeError(step.error)}))});
    }
  }
  console.log(JSON.stringify({recording,transcriptJson:row.transcriptJson??null,pipelines,pipelineQueryLimit:200}));
})().catch(error=>{console.error(error.message);process.exit(1)});
`;

export function normalizeSpeech(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const findTokens = (haystack, needle, from) => {
  if (!needle.length) return -1;
  for (let at = from; at <= haystack.length - needle.length; at++) {
    if (needle.every((word, offset) => haystack[at + offset] === word)) return at;
  }
  return -1;
};

export function validateContent(doc, scene, participants) {
  if (!doc || !Array.isArray(doc.segments)) throw new Error('Native TranscriptDoc must contain a segments array');
  const segments = doc.segments.map((segment, index) => ({ ...segment, index }));
  const speech = segments.filter(segment => segment.kind !== 'reaction' && normalizeSpeech(segment.text))
    .sort((a, b) => (Number(a.startMs) || 0) - (Number(b.startMs) || 0) || a.index - b.index);
  const tokens = [], tokenSegments = [];
  for (const segment of speech) {
    for (const token of normalizeSpeech(segment.text).split(' ')) { tokens.push(token); tokenSegments.push(segment); }
  }
  let cursor = 0;
  const turns = scene.turns.map(turn => {
    const expected = normalizeSpeech(turn.speech).split(' ');
    const at = findTokens(tokens, expected, cursor);
    const presentAnywhere = findTokens(tokens, expected, 0) >= 0;
    const covered = at < 0 ? [] : [...new Set(tokenSegments.slice(at, at + expected.length))];
    const nativeSpeakerIds = [...new Set(covered.map(segment => segment.speakerId).filter(Boolean))];
    const nativeSpeakerLabels = [...new Set(covered.map(segment => segment.speakerLabel).filter(Boolean))];
    if (at >= 0) cursor = at + expected.length;
    return {
      turnId: turn.id, expectedActor: turn.actor, expectedSpeech: turn.speech,
      exactNormalizedLinePresent: presentAnywhere, exactNormalizedLineInOrder: at >= 0,
      tokenRange: at < 0 ? null : { start: at, endExclusive: at + expected.length },
      nativeSpeakerIds, nativeSpeakerLabels,
      nativeActorAttribution: at < 0 ? 'no-matching-speech'
        : nativeSpeakerIds.length === 1 && nativeSpeakerIds[0] === turn.actor ? 'matches-expected-actor'
          : nativeSpeakerIds.length === 1 && nativeSpeakerIds[0] === 'call' ? 'mixed-call-unattributed'
            : 'unavailable-or-different',
    };
  });
  const expectedWords = normalizeSpeech(scene.turns.map(turn => turn.speech).join(' '));
  const actualWords = tokens.join(' ');
  const participantIds = new Set((participants ?? []).map(participant => participant.userId));
  const expectedActors = [...new Set(scene.turns.map(turn => turn.actor))];
  return {
    totalSegments: segments.length, speechSegments: speech.length,
    reactionSegments: segments.filter(segment => segment.kind === 'reaction').length,
    actualSpeech: speech.map(segment => segment.text).join('\n'),
    actualNormalizedSpeech: actualWords, expectedNormalizedSpeech: expectedWords,
    hasSpeech: tokens.length > 0, exactNormalizedSceneMatch: actualWords === expectedWords && tokens.length > 0,
    allFourLinesPresent: turns.length === 4 && turns.every(turn => turn.exactNormalizedLinePresent),
    allFourLinesInOrder: turns.length === 4 && turns.every(turn => turn.exactNormalizedLineInOrder),
    expectedActors, missingParticipantIds: expectedActors.filter(id => !participantIds.has(id)),
    participantsMatchExpectedActors: expectedActors.every(id => participantIds.has(id)),
    perLineNativeActorAttributionAvailable: turns.every(turn => turn.nativeActorAttribution === 'matches-expected-actor'),
    turns,
  };
}

async function main(args) {
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    if (at < 0) return fallback;
    if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a value`);
    return args[at + 1];
  };
  if (args.includes('--help')) {
    console.log(`Validate actual native recorded speech without changing runtime state.

node scripts/demos/validate-huddle-transcripts.mjs --scene initiative --recording <id> --verify --out /private/tmp/initiative-transcript-content.json

--scene           required storyboard scene (initiative or deck)
--recording       required actual native recording ID
--storyboard      defaults to docs/demos/work-huddles/storyboard.json
--container       existing native platform, default orgiq-media-validation-platform-api
--transcript-json optional native GET body, or browser-captured {status, doc/body} wrapper
--out             optional JSON evidence path
--verify          exit 2 unless genuine speech, all four ordered lines, participants and composition pass

Reads existing compiled native repositories only. No calls, recording jobs,
transcription runs, token minting, or service changes. Mixed Call attribution
and summary status remain separate from actual script-word acceptance.`);
    return;
  }
  const sceneId = option('--scene', null), recordingId = option('--recording', null);
  if (!sceneId || !recordingId || !/^[A-Za-z0-9_.:-]+$/.test(recordingId)) throw new Error('--scene and a valid --recording are required');
  const storyboardPath = resolve(option('--storyboard', 'docs/demos/work-huddles/storyboard.json'));
  const storyboardRaw = readFileSync(storyboardPath);
  const storyboard = JSON.parse(storyboardRaw);
  const scene = storyboard.scenes?.find(row => row.id === sceneId);
  if (!scene || scene.turns?.length !== 4) throw new Error('Scene must define exactly four storyboard turns');
  const container = option('--container', 'orgiq-media-validation-platform-api');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(container)) throw new Error('Invalid container name');
  const result = await exec('colima', ['ssh', '--', 'docker', 'exec', container, 'node', '-e', nativeRead, recordingId], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  const native = JSON.parse(result.stdout.trim());
  const storedDoc = typeof native.transcriptJson === 'string' ? JSON.parse(native.transcriptJson) : native.transcriptJson;
  const storedContent = storedDoc ? validateContent(storedDoc, scene, native.recording.participants) : null;
  const apiPath = option('--transcript-json', null);
  let apiProof;
  if (apiPath) {
    const raw = readFileSync(resolve(apiPath));
    const captured = JSON.parse(raw);
    const wrapped = Object.hasOwn(captured, 'status')
      && (Object.hasOwn(captured, 'doc') || Object.hasOwn(captured, 'body'));
    const doc = wrapped ? (captured.doc ?? captured.body) : captured;
    const content = Array.isArray(doc?.segments) ? validateContent(doc, scene, native.recording.participants) : null;
    apiProof = { source: 'externally captured participant-authorized native TranscriptDoc body',
      sha256: createHash('sha256').update(raw).digest('hex'), capturedHttpStatus: wrapped ? captured.status : null,
      capturedAt: wrapped ? (captured.at ?? captured.observedAt ?? null) : null,
      transcriptStatus: doc?.transcriptStatus, summaryStatus: doc?.summaryStatus, content,
      agreesWithNativeStoredSpeech: Boolean(content && content.actualNormalizedSpeech === storedContent?.actualNormalizedSpeech) };
  }
  const compositionReady = Boolean(native.recording.endedAt)
    && ['ok', 'degraded'].includes(native.recording.composeStatus)
    && native.pipelines.some(run => run.pipelineId === 'recording-finalize' && run.status === 'completed');
  const contentPass = Boolean(storedContent?.hasSpeech && storedContent.allFourLinesInOrder
    && native.recording.transcriptStatus === 'ready');
  const participantsPass = Boolean(storedContent?.participantsMatchExpectedActors);
  const apiPass = apiPath ? Boolean(apiProof?.content?.hasSpeech && apiProof.content.allFourLinesInOrder
    && (apiProof.capturedHttpStatus === null || apiProof.capturedHttpStatus === 200)
    && apiProof.agreesWithNativeStoredSpeech && apiProof.transcriptStatus === 'ready') : null;
  const report = {
    kind: 'native-huddle-transcript-content-validation', observedAt: new Date().toISOString(), readOnly: true,
    scene: sceneId, storyboardSha256: createHash('sha256').update(storyboardRaw).digest('hex'),
    recording: native.recording, pipelines: native.pipelines, pipelineQueryLimit: native.pipelineQueryLimit,
    nativeStoredContent: storedContent, apiProof,
    acceptance: { compositionReady, transcriptContentPass: contentPass, recordingParticipantMetadataPass: participantsPass,
      apiBodyProvided: Boolean(apiPath), apiBodyPass: apiPass,
      contentAndCompositionPass: compositionReady && contentPass && (!apiPath || apiPass),
      allChecksPass: compositionReady && contentPass && participantsPass && (!apiPath || apiPass),
      exactNormalizedSceneMatch: storedContent?.exactNormalizedSceneMatch ?? false,
      perLineNativeActorAttributionAvailable: storedContent?.perLineNativeActorAttributionAvailable ?? false,
      summaryStatus: native.recording.summaryStatus ?? 'not-set' },
    limits: [
      'Ready/HTTP200 does not prove speech. Empty or reaction-only TranscriptDocs fail this content gate.',
      'Exact normalized lines and their order are checked; punctuation is ignored, words and actor identities are not invented.',
      'Participant identities come from actual recording metadata and are distinct from speaker attribution.',
      'The deployed native composed-media ASR labels speech as Call; this is mixed audio, not per-person diarization.',
      'Composition and transcript content are separate from summary/model success. No summary success is implied.',
      'Repository reads do not prove endpoint authorization. Optional API body evidence comes from the separate actor browser capture.',
      'This validates recorded words, not perceptual lip synchronization or independent audiovisual playback.',
    ],
  };
  const output = option('--out', null);
  if (output) { const target = resolve(output); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  console.log(JSON.stringify(report, null, 2));
  if (args.includes('--verify') && !report.acceptance.allChecksPass) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
