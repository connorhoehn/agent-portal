// Milo's notes on fixed inputs (lib/interviews/milo-notes/notes.ts; row I3.6, the part with no model).
import { competencyNotes, notesStartMs, timeCheck, type NotesInput } from '../notes.js';

const INPUT: NotesInput = {
  competencies: [{ id: 'communication', name: 'Communication' }, { id: 'collaboration', name: 'Collaboration' }, { id: 'delivery', name: 'Delivery' }],
  chosen: [
    { id: 'q-incident', prompt: 'Tell me about an incident you led. What happened first?', competencyId: 'communication' },
    { id: 'q-disagree', prompt: 'Tell me about a time you disagreed with a technical decision.', competencyId: 'collaboration' },
    { id: 'q-handoff', prompt: 'How do you hand off work before a holiday?', competencyId: 'collaboration' },
    { id: 'q-ship', prompt: 'Walk me through the last thing you shipped.', competencyId: 'delivery' },
  ],
  panelLines: ['Thanks for coming. So, tell me about an incident you led — what happened first?'],
  suggestions: [
    { text: 'Tell me about a time you disagreed with a technical decision.', competencyId: 'collaboration', answer: 'milo-ask', dropped: null },
    { text: 'Who did you bring in first, and when?', competencyId: 'communication', answer: 'ask', dropped: null },
    { text: 'Walk me through the last thing you shipped.', competencyId: 'delivery', answer: 'skip', dropped: null },
    { text: '', competencyId: null, answer: null, dropped: 'judges' },
  ],
};

describe('competencyNotes', () => {
  it('says what was asked about per competency and which chosen questions are still to ask', () => {
    expect(competencyNotes(INPUT)).toEqual([
      { id: 'communication', name: 'Communication',
        asked: [
          { text: 'Tell me about an incident you led. What happened first?', questionId: 'q-incident', by: 'panel' },
          { text: 'Who did you bring in first, and when?', questionId: null, by: 'panel' },
        ],
        toAsk: [] },
      { id: 'collaboration', name: 'Collaboration',
        asked: [{ text: 'Tell me about a time you disagreed with a technical decision.', questionId: 'q-disagree', by: 'milo' }],
        toAsk: [{ questionId: 'q-handoff', text: 'How do you hand off work before a holiday?' }] },
      // A skipped suggestion is not asked.
      { id: 'delivery', name: 'Delivery', asked: [], toAsk: [{ questionId: 'q-ship', text: 'Walk me through the last thing you shipped.' }] },
    ]);
  });

  it('never reads the candidate, and carries no judgement: only asked and to ask', () => {
    const notes = competencyNotes({ ...INPUT, panelLines: [], suggestions: [] });
    expect(notes.every((c) => c.asked.length === 0)).toBe(true);
    expect(JSON.stringify(notes)).not.toMatch(/covered|well|strong|weak|score|percent|%/i);
  });
});

describe('timeCheck', () => {
  const start = Date.UTC(2026, 10, 17, 10, 0);
  it('counts minutes in and left from the start', () => {
    expect(timeCheck(start, 45, start + 12 * 60_000 + 30_000)).toEqual({ startedAt: new Date(start).toISOString(), minutesIn: 12, minutes: 45, minutesLeft: 33, line: '12 of 45 min, 33 min left.' });
    expect(timeCheck(start, 45, start + 45 * 60_000).line).toBe('45 of 45 min, no time left.');
    expect(timeCheck(start, 45, start + 50 * 60_000)).toMatchObject({ minutesLeft: 0, line: '50 of 45 min, over by 5 min.' });
    expect(timeCheck(start, 45, start - 4 * 60_000).line).toBe('Starts in 4 min; the round is 45 min.');
  });
  it('says plainly when the start is not known', () => {
    expect(timeCheck(null, 60, start)).toEqual({ startedAt: null, minutesIn: null, minutes: 60, minutesLeft: null, line: 'The round is 60 min; its start time is not known yet.' });
  });
  it('counts from the set time, else from when Milo joined the call', () => {
    expect(notesStartMs('2026-11-17T10:00:00.000Z', 5)).toBe(start);
    expect(notesStartMs(null, 5)).toBe(5);
    expect(notesStartMs(null, null)).toBeNull();
  });
});
