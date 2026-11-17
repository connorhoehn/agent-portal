// Milo's notes on fixed inputs (lib/interviews/milo-notes/notes.ts; row I3.6, the part with no model).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { MemoryAssistantStore } from '../../../meeting-assistant/store.js';
import { setAssistantStore } from '../../../meeting-assistant/store-select.js';
import { newAssistantSession, type AssistantRecord } from '../../../meeting-assistant/types.js';
import { competencyNotes, notesStartMs, timeCheck, type NotesInput } from '../notes.js';
import { notesFor, setMiloDeps, type MiloRef } from '../service.js';
import { assistantLiveTranscript } from '../transcript.js';

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

describe('the edges (hardening H3, O-120): the notes over the meeting assistant\'s real transcript store', () => {
  const IV = 'iv-long';
  const CALL = 'call-long';
  const T0 = Date.UTC(2026, 10, 17, 10, 0);
  const SHIP = 'Walk me through the last thing you shipped.';
  const INCIDENT = 'Tell me about an incident you led. What happened first?';
  let store: MemoryAssistantStore;
  let now: number;
  const ref = (scheduledAt: string | null = null): MiloRef => ({
    interview: { id: IV, callId: CALL, questionIds: ['q-incident', 'q-ship'], scheduledAt, minutes: 60, type: 'behavioural', leadId: 'u-wen' } as never,
    opening: { kit: {
      competencies: [{ id: 'communication', name: 'Communication' }, { id: 'delivery', name: 'Delivery' }],
      questions: [{ id: 'q-incident', prompt: INCIDENT, competencyId: 'communication' }, { id: 'q-ship', prompt: SHIP, competencyId: 'delivery' }],
    } } as never,
    candidateName: 'Nadia Petrova', nameOf: (id) => id,
  });
  const say = async (userId: string, text: string, n: number) => {
    await store.appendLine({ callId: CALL, userId, participantId: `${userId}-p`, speakerName: userId, text, at: T0 + n * 100, captionId: `c-${n}` });
  };

  beforeEach(async () => {
    now = T0 + 20 * 60_000;
    store = new MemoryAssistantStore(); setAssistantStore(store);
    await store.create({
      callId: CALL, tenant: 'interviews', lobby: `interviews:interview:${IV}`, initiativeId: null, state: 'listening', invitedBy: 'u-wen', invitedAt: T0, pausedBy: null, leftAt: null, leftBy: null,
      acked: ['u-wen'], attendees: ['u-wen'], presentAtInvite: ['u-wen'], requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(4500),
    } as AssistantRecord);
    setMiloDeps({ transcript: assistantLiveTranscript, consents: async () => ({ transcription: true, milo: true }), suggestions: async () => [], now: () => now });
  });
  afterEach(() => { setMiloDeps(null); setAssistantStore(null); });

  it('more than 5000 lines: the notes read the first 5000 only, so a chosen question asked after line 5000 is still listed to ask', async () => {
    for (let n = 1; n <= 5100; n += 1) {
      const text = n === 4991 ? INCIDENT : n === 5051 ? SHIP : `Line ${n} of a very long call.`;
      await say(n % 2 ? 'u-wen' : 'guest:inv-1', text, n);
    }
    const { notes } = await notesFor(ref());
    const byId = Object.fromEntries(notes.competencies.map((c) => [c.id, c]));
    expect(byId['communication']!.asked).toEqual([{ text: INCIDENT, questionId: 'q-incident', by: 'panel' }]);   // line 4991: read
    expect(byId['delivery']!.asked).toEqual([]);                                                                      // line 5051: past the read
    expect(byId['delivery']!.toAsk).toEqual([{ questionId: 'q-ship', text: SHIP }]);
  });

  it('Milo rejoined: its notes still count from when it first joined the call, unless the round has a set time', async () => {
    await say('u-wen', INCIDENT, 1);
    await store.transition(CALL, { from: ['listening'], to: 'left', by: 'u-wen', at: T0 + 10 * 60_000 });
    const left = (await store.get(CALL))!;
    expect(await store.rejoin(CALL, { leftAt: left.leftAt!, by: 'u-wen', at: T0 + 15 * 60_000, present: ['u-wen'], session: {} })).not.toBeNull();
    await say('u-wen', SHIP, 2);
    expect((await assistantLiveTranscript({ id: IV, callId: CALL }, 0))!.startedAtMs).toBe(T0);
    const { notes } = await notesFor(ref());
    expect(notes.time).toEqual({ startedAt: new Date(T0).toISOString(), minutesIn: 20, minutes: 60, minutesLeft: 40, line: '20 of 60 min, 40 min left.' });
    // Both periods' lines are read: what was asked before the rejoin still counts.
    expect(notes.competencies.flatMap((c) => c.asked.map((a) => a.questionId))).toEqual(['q-incident', 'q-ship']);
    const set = await notesFor(ref(new Date(T0 + 5 * 60_000).toISOString()));
    expect(set.notes.time.minutesIn).toBe(15);
  });
});
