// The export's own two sections (row I6.2): the suggestion log as stored, and the notice with the candidate's answers.
import { exportRecap } from '../recap/index.js';
import { exportCoachLog } from '../milo-notes/index.js';
import { exportPanelNotices } from '../consent/panel-notice.js';
import { CONSENT_NOTICE } from '../consent/notice.js';
import { consentStore } from '../consent/store.js';
import { suggestionStore, type SuggestionRecord } from '../coach/store.js';
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
  const text = c.noticeVersion === CONSENT_NOTICE.version ? { title: CONSENT_NOTICE.title, paragraphs: CONSENT_NOTICE.paragraphs } : null;
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

registerExportSection({ key: 'suggestions', read: exportSuggestions });
registerExportSection({ key: 'notices', read: exportNotices });
// Round 5 combine (E8): the recap, the lead's private answers and the panel's notice acknowledgements.
registerExportSection({ key: 'recap', read: exportRecap });
registerExportSection({ key: 'milo-for-you', read: exportCoachLog });
registerExportSection({ key: 'panel-notices', read: exportPanelNotices });
