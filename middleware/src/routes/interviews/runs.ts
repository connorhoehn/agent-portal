// /api/interviews — runs of the code pad, the panel's side (docs/interviews-tenant-plan.md decisions 3, 13, 18; row I4.4;
// contract U4). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   POST /interviews/:id/runs                 body { runId, language, files, entrypoint, stdin? } → 202 { run }; the same
//                                             runId again → 200 { run } and nothing started; the 61st → 429 { error };
//                                             a refused hold → 402 { error }; a bad body → 400 { error }
//   GET  /interviews/:id/runs                 → { runs } newest first
//   GET  /interviews/:id/runs/events          server-sent events for the whole interview: `id: <runId>:<seq>`,
//                                             `data: { runId, seq, stream, data, at }`; resumes after `Last-Event-ID`
//   GET  /interviews/:id/runs/:runId          → { run }
//   POST /interviews/:id/runs/:runId/cancel   → { run }; either person may cancel any run of the interview
//
// Who: a seat (the lead or the panel) holding ConductInterview, on a technical round that is `live`. Everyone else gets
// the tenant's one not-found, whatever the reason: a behavioural round, another interview, a round not live, the
// recruiter or hiring manager without a seat, the admin, a guest (refused at the router's gate first). The limits are
// the server's; the body never sets them. The stream closes when the interview stops being live (checked every
// RUN_STREAM_CHECK_MS) and at the latest after the round's length plus 30 minutes.
import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { isGuestId } from '../../lib/interviews/milo-policy.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import type { Interview } from '../../lib/interviews/types.js';
import {
  cancelRun, checkRunBody, eventId, getRun, listRuns, MAX_RUNS_PER_INTERVIEW, openRunEvents, runnerView, runView, startRun,
  type RunPerson, type RunRecord, type RunView,
} from '../../lib/interviews/runs/index.js';
import { endSSE, initSSE, writeSSE } from '../../lib/sse.js';

export const runsRouter = Router();

const NO_RUN = 'There is no run here for you.';
export const RUN_LIMIT_SENTENCE = `This interview has used all ${MAX_RUNS_PER_INTERVIEW} of its runs, so no more can be started.`;

/** How often an open stream checks that the interview is still live; tests shorten it. */
let checkMs = 15_000;
/** The stream's longest life past the round's own length. */
export const STREAM_GRACE_MS = 30 * 60_000;
export function setRunStreamTiming(t: { checkMs?: number } | null): void { checkMs = t?.checkMs ?? 15_000; }

/** The interview, when the viewer holds a seat on it with ConductInterview and it is a live technical round. */
async function runSeat(req: Request): Promise<{ interview: Interview; person: RunPerson } | null> {
  const session = resolveSession(req)!;
  if (!session.role || session.role === 'admin' || isGuestId(session.sub)) return null;
  if (!(await isAllowed(session, 'ConductInterview'))) return null;
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!interview || interview.type !== 'technical' || interview.state !== 'live' || !seatOf(interview, session.sub)) return null;
  return { interview, person: { id: session.sub, name: ix.people(session.sub).name, side: 'panel' } };
}

async function seatOrThrow(req: Request): Promise<{ interview: Interview; person: RunPerson }> {
  const s = await runSeat(req);
  if (!s) throw new NotFoundError(NO_RUN);
  return s;
}

/** The start's answer, shared by both sides; `view` and the refusal sentence are the side's own. */
export async function answerStart(res: Response, interviewId: string, person: RunPerson, raw: unknown,
  side: { view: (r: RunRecord) => RunView; refused: (body: Record<string, unknown>) => string }): Promise<void> {
  const checked = checkRunBody(raw);
  if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
  const out = await startRun(interviewId, person, checked.body);
  if (out.kind === 'limit') { res.status(429).json({ error: RUN_LIMIT_SENTENCE }); return; }
  if (out.kind === 'refused') { res.status(402).json({ error: side.refused(out.refusal.body) }); return; }
  res.status(out.kind === 'created' ? 202 : 200).json({ run: side.view(out.run) });
}

/**
 * The interview's event stream, shared by both sides. `stillAllowed` is asked every `checkMs`; the stream ends when it
 * says no, at `maxMs`, or when the reader goes.
 */
export async function serveRunStream(req: Request, res: Response, interviewId: string, maxMs: number, stillAllowed: () => Promise<boolean>): Promise<void> {
  const header = req.headers['last-event-id'];
  const query = req.query['lastEventId'];
  const last = typeof header === 'string' && header ? header : typeof query === 'string' && query ? query : null;
  initSSE(res);
  let closed = false;
  let stop: () => void = () => undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    endSSE(res);
  };
  req.on('close', close);
  try {
    stop = await openRunEvents(interviewId, last, (e) => { if (!closed) writeSSE(res, e, eventId(e)); });
  } catch (e) {
    console.warn('[interviews] run stream not opened', (e as Error)?.name ?? 'error');
    close();
    return;
  }
  if (closed) { stop(); return; }
  const limit = setTimeout(close, maxMs);
  limit.unref?.();
  let checking = false;
  const check = setInterval(() => {
    if (checking || closed) return;
    checking = true;
    stillAllowed().then((ok) => { if (!ok) close(); }, () => close()).finally(() => { checking = false; });
  }, checkMs);
  check.unref?.();
  timers.push(limit, check);
}

runsRouter.post('/interviews/:id/runs', asyncHandler(async (req, res) => {
  const { interview, person } = await seatOrThrow(req);
  res.setHeader('Cache-Control', 'no-store');
  // A refused hold says what the money is, plainly, as the coach's and Milo's refusals do.
  await answerStart(res, interview.id, person, req.body, {
    view: runView, refused: (body) => (typeof body['error'] === 'string' ? body['error'] : 'This run would cost more than this interview has left, so it was not started.'),
  });
}));

runsRouter.get('/interviews/:id/runs', asyncHandler(async (req, res) => {
  const { interview } = await seatOrThrow(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ runs: (await listRuns(interview.id)).map(runView), runner: runnerView() });
}));

runsRouter.get('/interviews/:id/runs/events', asyncHandler(async (req, res) => {
  const { interview, person } = await seatOrThrow(req);
  await serveRunStream(req, res, interview.id, interview.minutes * 60_000 + STREAM_GRACE_MS, async () => {
    const now = (await interviewsStore().listInterviews()).find((i) => i.id === interview.id);
    return !!now && now.state === 'live' && !!seatOf(now, person.id);
  });
}));

runsRouter.get('/interviews/:id/runs/:runId', asyncHandler(async (req, res) => {
  const { interview } = await seatOrThrow(req);
  const run = await getRun(interview.id, param(req, 'runId'));
  if (!run) throw new NotFoundError(NO_RUN);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ run: runView(run) });
}));

runsRouter.post('/interviews/:id/runs/:runId/cancel', asyncHandler(async (req, res) => {
  const { interview } = await seatOrThrow(req);
  const out = await cancelRun(interview.id, param(req, 'runId'));
  if (out.kind === 'not-found') throw new NotFoundError(NO_RUN);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ run: runView(out.run) });
}));
