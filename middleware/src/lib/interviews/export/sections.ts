// The export's own sections (row I6.2): the suggestion log as stored, the notice with the candidate's answers, and what Milo
// said aloud (the said log, added by the H5 fix).
import { exportRecap } from '../recap/index.js';
import { exportCoachLog } from '../milo-notes/index.js';
import { exportPanelNotices } from '../consent/panel-notice.js';
import { noticeOfVersion } from '../consent/notice.js';
import { consentStore } from '../consent/store.js';
import { suggestionStore, type SuggestionRecord } from '../coach/store.js';
import { saidStore } from '../speak/store.js';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { registerExportSection } from './registry.js';

/** Every row of the log as stored, newest last; the attempts that left no suggestion are counted by code. */
export async function exportSuggestions(interviewId: string): Promise<unknown> {
  const rows: SuggestionRecord[] = await suggestionStore().listSuggestions(interviewId);
  const dropped: Record<string, number> = {};
  for (const r of rows) if (r.dropped) dropped[r.dropped] = (dropped[r.dropped] ?? 0) + 1;
  return {
    suggestions: rows.filter((r) => r.dropped === null).map((r) => ({
      id: r.id, text: r.text, competencyId: r.competencyId, basedOn: r.basedOn, madeAt: r.madeAt, shownAt: r.shownAt,
      answer: r.answer, answeredAt: r.answeredAt, spoken: r.spoken, modelId: r.modelId, promptVersion: r.promptVersion,
    })),
    dropped,
  };
}

/** The notice version and its full text as given, and the three answers with their times; null answers when none were given. */
export async function exportNotices(interviewId: string): Promise<unknown> {
  const c = await consentStore().getConsent(interviewId);
  if (!c) return { notice: null, answers: null };
  const given = noticeOfVersion(c.noticeVersion);
  const text = given ? { title: given.title, paragraphs: given.paragraphs } : null;
  return {
    notice: { version: c.noticeVersion, ...(text ?? { title: null, paragraphs: null }), textKept: text !== null },
    answeredAt: c.answeredAt,
    answers: {
      recording: { answer: c.recording, at: c.recordingAt },
      transcription: { answer: c.transcription, at: c.transcriptionAt },
      milo: { answer: c.milo, at: c.miloAt },
    },
  };
}

/**
 * What Milo said aloud in the call (the said log), oldest first: each line with its time, its kind (a question or an answer),
 * where its words came from and whether it was relayed aloud. Who asked is the side and, for staff, their id: the candidate's
 * guest id is never shown to the panel, as in the record.
 */
export async function exportSaidLog(interviewId: string): Promise<unknown> {
  const rows = await runWithDbTenant(INTERVIEWS_TENANT, () => saidStore().list(interviewId));
  return {
    lines: rows.map((r) => ({
      id: r.id, saidAt: r.saidAt, kind: r.kind, source: r.source, text: r.text, spoken: r.spoken,
      questionId: r.questionId, suggestionId: r.suggestionId,
      askedBy: /^guest:/.test(r.askedBy) ? { side: 'candidate' as const } : { side: 'panel' as const, id: r.askedBy },
    })),
  };
}

registerExportSection({ key: 'suggestions', read: exportSuggestions });
registerExportSection({ key: 'notices', read: exportNotices });
// Round 5 combine (E8): the recap, the lead's private answers and the panel's notice acknowledgements.
registerExportSection({ key: 'recap', read: exportRecap });
registerExportSection({ key: 'milo-for-you', read: exportCoachLog });
registerExportSection({ key: 'panel-notices', read: exportPanelNotices });
registerExportSection({ key: 'said-aloud', read: exportSaidLog });
