// D4: what an interview runs with, for all eight combinations and for no answers (lib/interviews/consent/effects.ts).
import { interviewRunsWith, partsOffOf } from '../effects.js';

const yn = [true, false] as const;
const combos = yn.flatMap((recording) => yn.flatMap((transcription) => yn.map((milo) => ({ recording, transcription, milo }))));

describe('interviewRunsWith', () => {
  it.each(combos)('%j', (a) => {
    expect(interviewRunsWith(a)).toEqual({
      recording: a.recording,
      transcript: a.transcription,
      coach: a.transcription && a.milo,
      miloMayBeInvited: a.transcription,
    });
  });

  it('runs nothing without answers', () => {
    expect(interviewRunsWith(null)).toEqual({ recording: false, transcript: false, coach: false, miloMayBeInvited: false });
  });

  it('treats anything but a real yes as no', () => {
    expect(interviewRunsWith({ recording: 'yes', transcription: 1, milo: true } as never)).toEqual(
      { recording: false, transcript: false, coach: false, miloMayBeInvited: false });
  });

  it('the coach is on exactly when the transcript and Milo are (the rule COACH holds through consentsFor)', () => {
    for (const a of combos) expect(interviewRunsWith(a).coach).toBe(a.transcription && a.milo);
  });
});

describe('partsOffOf', () => {
  it('names what is off; Milo is off whenever the transcript is', () => {
    expect(partsOffOf({ recording: true, transcription: true, milo: true })).toEqual([]);
    expect(partsOffOf({ recording: false, transcription: true, milo: true })).toEqual(['recording']);
    expect(partsOffOf({ recording: true, transcription: false, milo: true })).toEqual(['transcription', 'milo']);
    expect(partsOffOf({ recording: true, transcription: true, milo: false })).toEqual(['milo']);
    expect(partsOffOf(null)).toEqual(['recording', 'transcription', 'milo']);
  });
});
