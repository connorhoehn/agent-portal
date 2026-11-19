// Consent records on a candidate's profile and the export of what Milo showed (docs/interviews-tenant-plan.md decisions
// 4, 5, 8 and 17; rows I6.1 and I6.2). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET /candidates/:id/consents    `{ reads: 'answers' | 'notice', items }`, one item per interview of the candidate in the
//                                   viewer's scope: the round's name, the interview's state, the notice version given and
//                                   when it was answered. The recruiter and the admin also read the three answers with
//                                   their times. The opening's hiring manager reads only that a notice was given (decision 5
//                                   keeps the choice off anything a decision is made from). Everyone else: not-found.
//   GET /interviews/:id/milo-export a JSON document of what Milo showed on one interview (lib/interviews/export). The recruiter
//                                   (ManageCandidates) within scope; everyone else: not-found. An attachment, never cached.
//                                   The export is written to no log; this route logs that one happened (who, which, when).
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { resolveSession } from '../../lib/authz.js';
import { consentStore } from '../../lib/interviews/consent/store.js';
import { buildMiloExport } from '../../lib/interviews/export/service.js';
import { competenciesOfRound } from '../../lib/interviews/kit.js';
import { indexFor, param } from '../../lib/interviews/request.js';

export const recordsRouter = Router();

const NO_CANDIDATE = 'There is no candidate here that you can open.';
const NO_INTERVIEW = 'There is no interview here that you can open.';
const ANSWER_READERS: ReadonlySet<string> = new Set(['recruiter', 'admin']);
const NOTICE_READERS: ReadonlySet<string> = new Set(['recruiter', 'admin', 'hiring-manager']);
/** A round that has ended: the export is offered once the call is over. */
const FINISHED: ReadonlySet<string> = new Set(['ended', 'scored', 'reviewed']);

export interface ConsentAnswerView { answer: boolean; at: string }
export interface ConsentRecordItem {
  interviewId: string;
  roundName: string;
  state: string;
  /** Whether a notice was answered at all. */
  answered: boolean;
  noticeVersion: string | null;
  answeredAt: string | null;
  /** The recruiter's and the admin's only. */
  answers?: { recording: ConsentAnswerView; transcription: ConsentAnswerView; milo: ConsentAnswerView };
  /** The recruiter's only: the round has ended and its export can be downloaded. */
  exportable?: boolean;
}

recordsRouter.get('/candidates/:id/consents', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!NOTICE_READERS.has(session.role)) throw new NotFoundError(NO_CANDIDATE);
  const ix = await indexFor(req);
  const candidate = ix.candidates.get(param(req, 'id'));
  if (!candidate) throw new NotFoundError(NO_CANDIDATE);
  const reads = ANSWER_READERS.has(session.role) ? 'answers' : 'notice';
  const apps = ix.world.applications.filter((a) => a.candidateId === candidate.id);
  const interviews = apps.flatMap((a) => ix.interviewsOf(a.id))
    .sort((a, b) => (a.scheduledAt ?? '9999').localeCompare(b.scheduledAt ?? '9999'));
  const items: ConsentRecordItem[] = await Promise.all(interviews.map(async (i) => {
    const c = await consentStore().getConsent(i.id);
    const item: ConsentRecordItem = {
      interviewId: i.id, roundName: ix.brief(i).roundName, state: i.state,
      answered: c !== null, noticeVersion: c?.noticeVersion ?? null, answeredAt: c?.answeredAt ?? null,
    };
    if (reads === 'answers') {
      if (c) item.answers = {
        recording: { answer: c.recording, at: c.recordingAt },
        transcription: { answer: c.transcription, at: c.transcriptionAt },
        milo: { answer: c.milo, at: c.miloAt },
      };
      if (session.role === 'recruiter') item.exportable = FINISHED.has(i.state);
    }
    return item;
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ reads, items });
}));

recordsRouter.get('/interviews/:id/milo-export', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (session.role !== 'recruiter') throw new NotFoundError(NO_INTERVIEW);
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((i) => i.id === param(req, 'id'));
  if (!interview) throw new NotFoundError(NO_INTERVIEW);
  const app = ix.applications.get(interview.applicationId);
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  const doc = await buildMiloExport({
    interview, candidateId: app?.candidateId ?? null, openingId: app?.openingId ?? null, roundName: ix.brief(interview).roundName,
    competencies: opening ? competenciesOfRound(opening.kit, interview.roundId) : [],
  });
  // That an export happened, and nothing of what it held.
  console.info(JSON.stringify({ event: 'interviews.milo-export', by: session.sub, interviewId: interview.id, at: doc.exportedAt }));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="milo-${interview.id}.json"`);
  res.type('application/json').send(JSON.stringify(doc, null, 2));
}));
