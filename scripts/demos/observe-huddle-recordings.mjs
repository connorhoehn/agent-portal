#!/usr/bin/env node
// Read-only observer for the existing local LVS/platform recording pipeline.
// Uses the platform's own compiled repositories; never starts a recording,
// composition job, transcription run, call, or service.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[at + 1];
};

// The only repository calls here are reads. Whitelist output fields before
// they leave the container: no complete checkpoint, token, URL, or transcript.
const nativeRead = String.raw`
const {callRecordingRepo,pipelineRunRepo}=require('/app/dist/repositories');
const lobby=process.argv[1],since=Date.parse(process.argv[2]);
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const safeError=value=>typeof value==='string'?value.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/([?&](?:token|sig|signature|key)=)[^&\s]+/gi,'$1[redacted]').slice(0,500):undefined;
(async()=>{
  const rows=[],seen=new Set();let cursor;
  for(let page=0;page<10;page++){
    const result=await callRecordingRepo.listByLobbyName(lobby,100,cursor);
    for(const row of result.items??[])if(Date.parse(row.startedAt)>=since){
      const rec=await callRecordingRepo.findByRecordingId(row.recordingId);
      if(rec?.lobbyName!==lobby||seen.has(rec.recordingId))continue;seen.add(rec.recordingId);
      rows.push({...pick(rec,['recordingId','callId','sessionId','channelArn','lobbyName','startedAt','endedAt','durationMs','sessionDurationMs','composeStatus','composeCheckedAt','transcriptStatus','transcriptStatusAt','summaryStatus','participantCount']),
        participants:(rec.participants??[]).map(p=>pick(p,['userId','displayName'])),
        tracks:(rec.tracks??[]).map(t=>pick(t,['legId','participantId','kind','durationMs','startedAtMs','endedAtMs','endReason','size'])),
        composedBytes:rec.composedSegment?.size,transcriptError:safeError(rec.transcriptError)});
    }
    cursor=result.cursor;if(!cursor)break;
  }
  const pipelines=[];
  for(const pipelineId of ['recording-finalize','call-transcription']){
    for(const run of await pipelineRunRepo.listByPipeline(pipelineId,{limit:200})){
      const ctx=run.checkpoint?.context??{};
      if(ctx.lobbyName!==lobby||Date.parse(ctx.startedAt??run.startedAt)<since)continue;
      pipelines.push({...pick(run,['pipelineId','runId','status','startedAt','completedAt','lastEventAt']),recordingId:ctx.recordingId,error:safeError(run.error),
        steps:Object.entries(run.stepsSummary??{}).map(([id,step])=>({id,...pick(step,['status','durationMs','completedAt']),attempts:step.attempts?.length,error:safeError(step.error)}))});
    }
  }
  console.log(JSON.stringify({recordings:rows.sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt)),pipelines,recordingCursorRemaining:Boolean(cursor),pipelineQueryLimit:200}));
})().catch(error=>{console.error(error.message);process.exit(1)});
`;

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Observer endpoints must be local HTTP origins without credentials');
  }
  return url.origin;
}

async function get(base, path, admin = false) {
  const res = await fetch(base + path, {
    headers: admin ? { Authorization: `Bearer ${process.env.LVS_ADMIN_TOKEN ?? 'admin'}` } : {},
    signal: AbortSignal.timeout(10_000), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Native GET ${path.split('?')[0]} returned ${res.status}`);
  return res.json();
}

const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));
const sfuRecording = row => ({
  ...pick(row, ['recordingId', 'startedAt', 'endedAt', 'durationMs', 'composeStatus', 'composeJobId', 'composeError']),
  composedBytes: row.composedSegment?.size,
  tracks: (row.tracks ?? []).map(track => pick(track, ['legId', 'participantId', 'kind', 'startedAtMs', 'endedAtMs', 'durationMs', 'endReason', 'size'])),
  timeline: row.timeline ? pick(row.timeline, ['version', 'epochMs', 'durationMs', 'participantEvents', 'stateEvents']) : undefined,
});

try {
  if (args.includes('--help')) {
    console.log(`Observe existing local recordings without changing service state.

node scripts/demos/observe-huddle-recordings.mjs --since <UTC timestamp> --expected 2 --watch 240 --out /private/tmp/huddle-recordings.json

--lobby      default orgiq:initiative:p-observability
--since      default now; older rehearsal recordings never satisfy the count
--expected   default 2
--watch      seconds to observe, default 0 (one snapshot), maximum 3600
--interval   seconds between snapshots, default 3
--out        optional JSON evidence destination
--verify     exit 2 unless the expected recordings composed and native finalize runs completed
--wait-pipeline also wait for the native transcription child runs to finish (including truthful failure)
--container  existing native platform container, default orgiq-media-validation-platform-api
--sfu        local native LVS origin, default http://127.0.0.1:3902
--platform   local native platform origin, default http://127.0.0.1:23002

LVS_ADMIN_TOKEN may supply the existing local admin credential. It is never printed.
Native repository reads use the existing container's configured datastore.
Compose completion is separate from transcript/summary success; both statuses are preserved.`);
    process.exit(0);
  }
  const lobby = option('--lobby', 'orgiq:initiative:p-observability');
  const since = option('--since', new Date().toISOString());
  if (!Number.isFinite(Date.parse(since))) throw new Error('--since must be a timestamp');
  const expected = Number(option('--expected', '2'));
  const watch = Number(option('--watch', '0'));
  const interval = Number(option('--interval', '3'));
  if (!Number.isInteger(expected) || expected < 1 || expected > 20 || !Number.isFinite(watch) || watch < 0 || watch > 3600 || !Number.isFinite(interval) || interval < 1 || interval > 30) throw new Error('Invalid expected/watch/interval bounds');
  const container = option('--container', 'orgiq-media-validation-platform-api');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(container)) throw new Error('Invalid container name');
  const sfu = localOrigin(option('--sfu', 'http://127.0.0.1:3902'));
  const platform = localOrigin(option('--platform', 'http://127.0.0.1:23002'));
  const out = option('--out', null);
  const deadline = Date.now() + watch * 1000;
  const seenArns = new Set();
  const observations = [];
  let report;
  do {
    const [nativeResult, health, peers, transports, channels] = await Promise.all([
      exec('colima', ['ssh', '--', 'docker', 'exec', container, 'node', '-e', nativeRead, lobby, since], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
      get(platform, '/health'), get(sfu, '/api/peers/stats', true), get(sfu, '/api/stats/transport', true), get(sfu, '/api/channels', true),
    ]);
    const native = JSON.parse(nativeResult.stdout.trim());
    const relevantChannels = channels.filter(channel => channel.name === lobby);
    for (const row of [...relevantChannels, ...native.recordings]) if (row.arn || row.channelArn) seenArns.add(row.arn ?? row.channelArn);
    const sfuRows = [];
    for (const arn of seenArns) {
      try {
        const [rows, state] = await Promise.all([
          get(sfu, `/api/channels/${encodeURIComponent(arn)}/recordings`, true),
          get(sfu, `/api/sessions/${encodeURIComponent(arn)}/recording`, true),
        ]);
        sfuRows.push({ channelArn: arn, liveRecording: pick(state, ['isRecording', 'recordingId', 'startedAt']),
          recordings: rows.filter(row => Date.parse(row.startedAt) >= Date.parse(since)).map(sfuRecording) });
      } catch (error) { sfuRows.push({ channelArn: arn, error: error.message }); }
    }
    const composed = native.recordings.filter(recording => recording.endedAt && ['ok', 'degraded'].includes(recording.composeStatus)
      && sfuRows.some(channel => channel.channelArn === recording.channelArn && channel.recordings?.some(row => row.recordingId === recording.recordingId && ['ok', 'degraded'].includes(row.composeStatus)))
      && native.pipelines.some(run => run.recordingId === recording.recordingId && run.pipelineId === 'recording-finalize' && run.status === 'completed'));
    const withTerminalTranscription = composed.filter(recording => native.pipelines.some(run => run.recordingId === recording.recordingId
      && run.pipelineId === 'call-transcription' && ['completed', 'failed', 'cancelled', 'rejected'].includes(run.status)));
    const observation = {
      observedAt: new Date().toISOString(),
      health: { status: health.status, checks: health.checks?.map(check => pick(check, ['name', 'ok', 'degraded', 'details'])) },
      // PeerManager counts the older signaling peers, not the native WHIP/WHEP
      // path. Preserve it as legacy telemetry; zero is never an idle proof.
      legacyPeers: pick(peers, ['activePeers', 'activeConnections', 'totalTransports', 'totalProducers', 'totalConsumers']),
      liveTransports: pick(transports, ['webRtcTransports', 'serverTransports', 'serverTransportsByType', 'pipeTransports', 'producers', 'consumers']),
      channels: relevantChannels.map(channel => ({ ...pick(channel, ['arn', 'name']), recordingConfiguration: pick(channel.recordingConfiguration, ['enabled', 'destination', 'recordingProfile', 'startWhenParticipants', 'transcribe', 'composePerPeer']) })),
      platform: native, sfu: sfuRows,
      acceptance: { expected, freshRecordings: native.recordings.length, composedWithCompletedNativeFinalize: composed.length,
        expectedComposed: composed.length >= expected, withTerminalTranscription: withTerminalTranscription.length,
        observationFinished: composed.length >= expected && (!args.includes('--wait-pipeline') || withTerminalTranscription.length >= expected) },
    };
    observations.push(observation);
    report = { kind: 'native-huddle-recording-observation', since, lobby, readOnly: true,
      contracts: ['existing platform CallRecordingRepository/PipelineRunRepository reads', 'native LVS GET channels/transport registry/live recording/recordings'], observations,
      latest: observation,
      limits: ['This observes metadata and native pipeline status. It does not prove speech accuracy, clip synchronization, or audiovisual playback.', 'legacyPeers is the older PeerManager registry and can stay zero during native WHIP/WHEP calls; use liveTransports and liveRecording state for activity.', 'Transcript and summary failure do not make a composed recording unplayable.', 'No recording, composition, transcription job, or service is started by this observer.'] };
    if (out) { const target = resolve(out); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
    if (!watch) console.log(JSON.stringify(report, null, 2));
    else console.log(JSON.stringify({ observedAt: observation.observedAt, ...observation.acceptance, liveTransports: observation.liveTransports,
      recordings: native.recordings.map(row => pick(row, ['recordingId', 'composeStatus', 'transcriptStatus'])), pipelines: native.pipelines.map(run => pick(run, ['pipelineId', 'recordingId', 'status'])) }));
    if (observation.acceptance.observationFinished || Date.now() >= deadline) break;
    await new Promise(done => setTimeout(done, Math.min(interval * 1000, deadline - Date.now())));
  } while (Date.now() <= deadline);
  if (args.includes('--verify') && !report.latest.acceptance.observationFinished) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
