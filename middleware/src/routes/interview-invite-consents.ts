// /api/interview-invite/consents: the candidate's three answers (docs/interviews-tenant-plan.md decision 5,
// row I2.3; contract C4). Mounted on the guest's router (routes/interview-invite.ts) with one line.
//
//   GET /consents   the current notice and the answers stored under it (all null when none, or when they
//                   were given under an older notice: the candidate is asked again), and `required`: the parts
//                   this deployment needs for the call to start (row I6.4). Declining one is still stored.
//   PUT /consents   body { noticeVersion, recording, transcription, milo }: all three answers at once, each a
//                   real yes or no (lib/interviews/consent/rules.ts). Declining the transcript stores Milo as
//                   declined. 400 for an incomplete set, 409 for a stale notice (the answer carries the
//                   current one), for a call that has started, or for a write another window made first.
//
// Behind the flag and requireGuest(), as every guest route: no cookie, a dead link, a replaced session or a
// staff session gets the one not-found answer. Nothing about the choice is written to a log line, a bell, a
// scorecard or the candidate's record: this file logs nothing and calls nothing but the consents store.

import { Router, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import { GUEST_REFUSAL, requireGuest } from '../lib/interviews/invite/guest.js';
import { CONSENT_NOTICE, type ConsentNotice } from '../lib/interviews/consent/notice.js';
import { checkAnswers, stampAnswers, type ConsentPart } from '../lib/interviews/consent/rules.js';
import { requiredConsents } from '../lib/interviews/consent/required.js';
import { consentStore, type ConsentRecord } from '../lib/interviews/consent/store.js';
import type { Interview } from '../lib/interviews/types.js';
import { interviewsFlagGate } from './interviews.js';
import { consentsSaved } from '../lib/interviews/consent-bell.js';
import { pushRecordingDecision } from '../lib/interviews/recording-push.js';
import { interviewsNow } from '../lib/interviews/clock.js';

export const consentGuestRouter: Router = Router();

/** C4's answer. */
export interface GuestConsentsView {
  notice: ConsentNotice;
  answers: { recording: boolean | null; transcription: boolean | null; milo: boolean | null };
  answeredAt: string | null;
  /** The parts this deployment requires for the call to start (row I6.4; contract F3), in the notice's order. */
  required: ConsentPart[];
}

const INCOMPLETE = 'Answer all three questions, yes or no, before you continue.';
const STALE_NOTICE = 'The notice has changed since this page showed it. Read it again, then answer.';
const CLOSED = 'Your interview has started, so these answers can no longer be changed.';
const RACED = 'Your answers were just saved from another window. Check them here, then continue.';

/** Answers under an older notice are not shown back: the candidate answers the current text afresh. */
export function guestConsentsView(record: ConsentRecord | null, required: ConsentPart[] = requiredConsents()): GuestConsentsView {
  const current = record && record.noticeVersion === CONSENT_NOTICE.version ? record : null;
  return {
    notice: { version: CONSENT_NOTICE.version, title: CONSENT_NOTICE.title, paragraphs: [...CONSENT_NOTICE.paragraphs] },
    answers: current
      ? { recording: current.recording, transcription: current.transcription, milo: current.milo }
      : { recording: null, transcription: null, milo: null },
    answeredAt: current ? current.changedAt : null,
    required: [...required],
  };
}

async function guestInterview(interviewId: string): Promise<Interview | null> {
  return (await interviewsStore().listInterviews()).find((i) => i.id === interviewId) ?? null;
}

function refuse(res: Response): void { res.status(404).json(GUEST_REFUSAL); }

consentGuestRouter.get('/consents', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const interview = await guestInterview(req.guest!.interviewId);
  if (!interview) { refuse(res); return; }
  res.json(guestConsentsView(await consentStore().getConsent(interview.id)));
}));

consentGuestRouter.put('/consents', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const interview = await guestInterview(req.guest!.interviewId);
  if (!interview) { refuse(res); return; }
  const store = consentStore();
  const before = await store.getConsent(interview.id);
  const checked = checkAnswers(req.body, CONSENT_NOTICE.version, interview.state, before);
  if (!checked.ok) {
    if (checked.reason === 'incomplete') { res.status(400).json({ error: INCOMPLETE }); return; }
    res.status(409).json({ error: checked.reason === 'closed' ? CLOSED : STALE_NOTICE, ...guestConsentsView(before) });
    return;
  }
  const at = interviewsNow().toISOString();
  // Answers under an older notice were given to another text: every answer is stamped afresh.
  const sameNotice = before && before.noticeVersion === checked.noticeVersion ? before : null;
  const stamped = stampAnswers(checked.answers, sameNotice && {
    recording: { value: sameNotice.recording, at: sameNotice.recordingAt },
    transcription: { value: sameNotice.transcription, at: sameNotice.transcriptionAt },
    milo: { value: sameNotice.milo, at: sameNotice.miloAt },
  }, at);
  const result = await store.saveConsent({
    interviewId: interview.id, noticeVersion: checked.noticeVersion,
    recording: stamped.recording.value, recordingAt: stamped.recording.at,
    transcription: stamped.transcription.value, transcriptionAt: stamped.transcription.at,
    milo: stamped.milo.value, miloAt: stamped.milo.at,
    changedAt: at,
    entry: { at, noticeVersion: checked.noticeVersion, ...checked.answers, miloForcedOff: checked.miloForcedOff },
  }, before?.revision ?? 0);
  if (!result.ok) {
    res.status(409).json({ error: RACED, ...guestConsentsView(result.reason === 'stale' ? result.row : null) });
    return;
  }
  void consentsSaved(interview.id, before, result.row);
  void pushRecordingDecision(interview.id);
  res.json(guestConsentsView(result.row));
}));
