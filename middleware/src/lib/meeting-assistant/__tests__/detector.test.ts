// The detector, built from captions observed in the 13 November measurement run
// (docs/meeting-assistant-design.md, "Spike result"). Time is a hand-driven clock: no sleeping.
import {
  RequestDetector, DETECTOR_LIMITS, nameLock, findAddress, isFillerSliver, looksCut, parseCommand, appendText, NAME_FORMS, NAME_SPELLINGS, nameTwins,
  type DetectorEvent,
} from '../detector.js';
import type { TranscriptLine } from '../types.js';

let now = 0;
let seq = 0;
let d: RequestDetector;
beforeEach(() => { now = 1_000_000; seq = 0; d = new RequestDetector('call-1', () => now); });

const say = (userId: string, text: string, advance = 0): DetectorEvent[] => {
  now += advance;
  const line: TranscriptLine = { callId: 'call-1', seq: ++seq, userId, participantId: `p-${userId}`, speakerName: userId, text, at: now, captionId: `c-${seq}` };
  return d.push(line);
};
const wait = (ms: number): DetectorEvent[] => { now += ms; return d.tick(); };
const requests = (e: DetectorEvent[]) => e.filter((x) => x.type === 'request');

describe('name matching', () => {
  it.each([
    ['Milo, write a summary', 'write a summary'],
    ['milo write a summary', 'write a summary'],
    ['MILO: write a summary', 'write a summary'],
    ['Hey Milo, write a summary', 'write a summary'],
    ['Okay. Milo - write a summary', 'write a summary'],
    ["Milo's notes please", 'notes please'],
    ['we are done with the retry logic. Milo, please.', 'please.'],
  ])('%j addresses the assistant', (text, rest) => {
    expect(findAddress(text)?.rest).toBe(rest);
  });

  it.each([['Milos will join later'], ['Camilo was right about it'], ['Milo-based tooling is fine'], ['plain chatter with no name at all']])(
    '%j is not the name', (text) => { expect(findAddress(text)).toBeNull(); },
  );

  it('"Milo, what is two plus two?" addresses the assistant', () => {
    expect(findAddress('Milo, what is two plus two?')?.rest).toBe('what is two plus two?');
  });

  it('the spellings a transcript writes the name with address it too, in any case', () => {
    expect(NAME_SPELLINGS).toEqual(['milo', 'mylo']);
    for (const text of ['Mylo, what is two plus two?', 'mylo what is two plus two?', 'MYLO: what is two plus two?', 'Hey Mylo, what is two plus two?']) {
      expect(findAddress(text)?.rest).toBe('what is two plus two?');
    }
    expect(findAddress("Mylo's notes please")?.rest).toBe('notes please');
    expect(findAddress('Mylos will join later')).toBeNull();
  });

  it('names the seated people whose first name is a way the name is heard (sweep 4 in-call 12)', () => {
    expect(nameTwins(['Vera Green', 'Milo Park', 'mylo chen', 'Camilo Ortiz', 'Milos Kovac', 'Milo Park', 'Ada Milo'])).toEqual(['Milo Park', 'mylo chen']);
    expect(nameTwins(['Vera Green'])).toEqual([]);
  });

  it('the old name is no longer an address', () => {
    for (const text of ['Nova, what is two plus two?', 'Hey Nova, write a summary', 'nova write a summary', 'so, Nova, can you help']) {
      expect(findAddress(text)).toBeNull();
    }
    expect(d.push({ callId: 'call-1', seq: 1, userId: 'u-a', participantId: 'p-a', speakerName: 'A', text: 'Nova, what is two plus two?', at: now, captionId: 'c-1' })).toEqual([]);
    expect(wait(10_000)).toEqual([]);
  });

  it('mid-sentence mention: not a request without a comma, imperative or "can you"', () => {
    expect(findAddress('I think Milo could help with that budget question')).toBeNull();
    expect(findAddress('thanks Milo.')).toBeNull();
    expect(findAddress('I asked Milo yesterday about it')).toBeNull();
  });

  it('mid-sentence mention: a comma, an imperative, a question word or "can you" makes it a request', () => {
    expect(findAddress('I think, Milo, could help')?.rest).toBe('could help');
    expect(findAddress('so Milo please summarise the call')?.rest).toBe('please summarise the call');
    expect(findAddress('right then Milo write up the incident')?.rest).toBe('write up the incident');
    expect(findAddress('hang on Milo what did Priya say')?.rest).toBe('what did Priya say');
    expect(findAddress('I think Milo could you help with the budget')?.rest).toBe('could you help with the budget');
  });

  it('a name that starts a sentence is addressing even without a comma', () => {
    expect(findAddress('That is fine. Milo the build is red again')?.rest).toBe('the build is red again');
  });

  it('a sentence that only mentions Milo to someone else is not an address: Milo as its object, or its subject in the third person', () => {
    // The lead telling the candidate, the moment before the candidate asks (live interview, 18 November).
    expect(findAddress("Great list! Tell you what? If you'd like more examples to check against, just ask Milo")).toBeNull();
    expect(findAddress('You can always talk to Milo.')).toBeNull();
    expect(findAddress('Milo can help with that')).toBeNull();
    expect(findAddress('Good question. Milo will sort that out')).toBeNull();
    // A person after the modal makes it a question to Milo; a comma after the name makes it an address.
    expect(findAddress('Milo can you add a dozen test cases')?.rest).toBe('can you add a dozen test cases');
    expect(findAddress('Milo could we get a summary')?.rest).toBe('could we get a summary');
    expect(findAddress('Milo, can help with that?')?.rest).toBe('can help with that?');
    // The name as the last word, not acted on by the sentence: the request is coming in the next line.
    expect(findAddress('Okay so Milo')?.rest).toBe('');
    expect(findAddress('Oh, nice! Hey Milo... It would be helpful to have another dozen test cases')?.rest).toBe('It would be helpful to have another dozen test cases');
  });
});

describe('fillers and cut detection', () => {
  it('knows the Whisper fillers, only up to two words', () => {
    for (const t of ['Thank you.', 'You', 'Bye.', 'thanks', ' Thank you! ', 'Okay.']) expect(isFillerSliver(t)).toBe(true);
    for (const t of ['team.', 'again. Thank you.', 'Thank you for the update', 'you know', '']) expect(isFillerSliver(t)).toBe(false);
  });
  it('flags captions that look cut by the window', () => {
    expect(looksCut('write up a short incident summary for the cluster and')).toBe(true);
    expect(looksCut('assign it to pr-')).toBe(true);
    expect(looksCut('create a work item for the bug')).toBe(true);
    expect(looksCut('assign it to Priya.')).toBe(false);
  });
  it('joins a half-cut word across the boundary only when the next part starts lowercase', () => {
    const a = ['assign it to pr-']; appendText(a, 'iya'); expect(a).toEqual(['assign it to priya']);
    const b = ['a well-']; appendText(b, 'Known thing'); expect(b).toEqual(['a well-', 'Known thing']);
    const c = ['assign it to']; appendText(c, 'Priya'); expect(c).toEqual(['assign it to', 'Priya']);
  });
});

describe('commands', () => {
  it.each([
    ['stop listening', 'pause'], ['Pause.', 'pause'], ['please stop listening', 'pause'], ['pause listening', 'pause'],
    ['leave', 'dismiss'], ['Leave the call.', 'dismiss'], ['please leave now', 'dismiss'],
    ['never mind', 'cancel'], ['Nevermind.', 'cancel'], ['cancel', 'cancel'], ['stop', 'cancel'], ['cancel that', 'cancel'],
    ['cancel the Friday standup', null], ['stop the deploy and tell me why', null], ['write a summary', null],
  ])('%j -> %s', (rest, want) => { expect(parseCommand(rest)).toBe(want); });
});

describe('the spike\'s split request', () => {
  it('stitches "Milo, please." + two captions into one request, closing 1.5 s after the last', () => {
    expect(say('u-vera', 'we are done with the retry logic. Milo, please.')).toEqual([]);
    expect(say('u-vera', 'write up a short incident summary for the cluster and', 1200)).toEqual([]);
    expect(say('u-vera', 'assign it to Priya.', 1500)).toEqual([]);
    expect(wait(DETECTOR_LIMITS.quietMs - 1)).toEqual([]);
    const [req, ...more] = wait(1);
    expect(more).toEqual([]);
    expect(req).toEqual({
      type: 'request', callId: 'call-1', askedBy: 'u-vera', lines: [1, 2, 3],
      text: 'please. write up a short incident summary for the cluster and assign it to Priya.',
      startedAt: 1_000_000, endedAt: 1_002_700,
    });
  });

  it('a bare opener ("Milo, please.") waits the long 4 s for the continuation', () => {
    say('u-vera', 'Milo, please.');
    expect(wait(3999)).toEqual([]);
    // Nothing came: an opener of one word closes as a (one-word) request, not silently.
    expect(requests(wait(1))).toHaveLength(1);
  });

  it('a caption landing after the quiet window starts nothing: the earlier request is closed first', () => {
    say('u-vera', 'Milo, please write a short summary of the call.');
    const e = say('u-vera', 'and then assign it to Priya.', 2000);
    expect(requests(e)).toHaveLength(1);
    expect((requests(e)[0] as { text: string }).text).toBe('please write a short summary of the call.');
    expect(d.hasOpen('u-vera')).toBe(false);
  });

  it('a cut-looking last caption stretches the wait to 4 s', () => {
    say('u-vera', 'Milo, write up the incident summary for the cluster and');
    expect(wait(DETECTOR_LIMITS.quietMs + 100)).toEqual([]);
    say('u-vera', 'assign it to Priya.', 100);
    expect(requests(wait(DETECTOR_LIMITS.quietMs))).toHaveLength(1);
  });
});

describe('half-cut word', () => {
  it('"pr-" then "iya" becomes "priya" in the request', () => {
    say('u-release', 'Milo, create a work item for the login cookie bug and assign it to pr-');
    say('u-release', 'iya', 900);
    const [req] = wait(DETECTOR_LIMITS.cutWaitMs); // no closing punctuation: looks cut, so the long wait
    expect(req).toMatchObject({ type: 'request', lines: [1, 2], text: 'create a work item for the login cookie bug and assign it to priya' });
  });
});

describe('junk slivers', () => {
  it('"again. Thank you." is three words, so by rule it is text, not a sliver', () => {
    say('u-vera', 'Milo, summarise what we decided');
    say('u-vera', 'again. Thank you.', 500);
    const [req] = wait(5000);
    expect((req as { text: string }).text).toBe('summarise what we decided again. Thank you.');
  });

  it('"team." is kept; "You" is dropped from stitching and from the request lines', () => {
    say('u-vera', 'Milo, write a short note for the');
    say('u-vera', 'team.', 400);
    expect(say('u-vera', 'You', 300)).toEqual([]);
    const [req] = wait(5000);
    expect(req).toMatchObject({ lines: [1, 2], text: 'write a short note for the team.' });
  });

  it('a lone sliver never opens a request, and the name inside a sliver cannot happen', () => {
    expect(say('u-vera', 'Thank you.')).toEqual([]);
    expect(say('u-vera', 'Bye.')).toEqual([]);
    expect(d.hasOpen('u-vera')).toBe(false);
    expect(wait(10_000)).toEqual([]);
  });

  it('a sliver does not extend the quiet window', () => {
    say('u-vera', 'Milo, list the open work items.');
    say('u-vera', 'You', 1000);
    expect(requests(wait(600))).toHaveLength(1);
  });
});

describe('plain chatter and the name mid-sentence', () => {
  it('chatter with no name produces nothing, ever', () => {
    expect(say('u-vera', 'so the retry logic needs a backoff')).toEqual([]);
    expect(say('u-release', 'agreed, we can ship it on Friday', 1000)).toEqual([]);
    expect(wait(60_000)).toEqual([]);
  });

  it('"I think Milo could help with that budget question" is not a request', () => {
    expect(say('u-vera', 'I think Milo could help with that budget question')).toEqual([]);
    expect(d.hasOpen('u-vera')).toBe(false);
    expect(wait(10_000)).toEqual([]);
  });

  it('...but "Milo, could you help with that budget question" is', () => {
    say('u-vera', 'I think, Milo, could you help with that budget question?');
    const [req] = wait(DETECTOR_LIMITS.quietMs);
    expect(req).toMatchObject({ type: 'request', text: 'could you help with that budget question?' });
  });

  it('the name as the last word opens the request with the same speaker\'s next caption', () => {
    expect(say('u-vera', 'Okay team, hey Milo')).toEqual([]);
    expect(d.hasOpen('u-vera')).toBe(true);
    say('u-vera', 'what is blocking the release?', 800);
    const [req] = wait(DETECTOR_LIMITS.quietMs);
    expect(req).toMatchObject({ type: 'request', lines: [1, 2], text: 'what is blocking the release?' });
  });

  it('an opener that nothing follows closes as an empty cancel, not a request', () => {
    say('u-vera', 'Hey Milo');
    const [e] = wait(DETECTOR_LIMITS.cutWaitMs);
    expect(e).toEqual({ type: 'cancel', callId: 'call-1', askedBy: 'u-vera', lines: [1], reason: 'empty' });
  });
});

describe('two speakers', () => {
  it('only the speaker who said the name has a request; the other\'s overlapping captions never join', () => {
    say('u-vera', 'Milo, write up the standup notes and');
    say('u-release', 'I will check the deploy window', 300);
    say('u-release', 'and the rollback plan.', 300);
    say('u-vera', 'send them to the channel.', 200);
    const events = wait(DETECTOR_LIMITS.quietMs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'request', askedBy: 'u-vera', lines: [1, 4], text: 'write up the standup notes and send them to the channel.' });
    expect(d.hasOpen('u-release')).toBe(false);
  });

  it('two people can each have an open request at once', () => {
    say('u-vera', 'Milo, list the open items.');
    say('u-release', 'Milo, what is the budget status?', 200);
    const events = wait(DETECTOR_LIMITS.quietMs + 200);
    expect(events.map((e) => (e as { askedBy: string }).askedBy).sort()).toEqual(['u-release', 'u-vera']);
  });
});

describe('cancel and commands', () => {
  it.each(['Milo, never mind', 'Milo, cancel', 'Milo, stop.'])('%j from the asker cancels the open request', (text) => {
    say('u-vera', 'Milo, write up the incident summary for the');
    const e = say('u-vera', text, 500);
    expect(e).toEqual([{ type: 'cancel', callId: 'call-1', askedBy: 'u-vera', lines: [1, 2], reason: 'cancelled' }]);
    expect(wait(10_000)).toEqual([]);
  });

  it('another speaker saying "Milo, never mind" does not cancel someone else\'s request', () => {
    say('u-vera', 'Milo, write up the incident summary for the cluster.');
    expect(say('u-release', 'Milo, never mind', 300)).toEqual([]);
    expect(requests(wait(DETECTOR_LIMITS.quietMs))).toHaveLength(1);
  });

  it('"never mind" with nothing open does nothing', () => {
    expect(say('u-vera', 'Milo, never mind')).toEqual([]);
  });

  it('pause, stop listening and leave are commands from any speaker, and open no request', () => {
    expect(say('u-release', 'Milo, stop listening.')).toEqual([{ type: 'command', callId: 'call-1', command: 'pause', by: 'u-release', line: 1 }]);
    expect(say('u-vera', 'Milo, pause')).toEqual([{ type: 'command', callId: 'call-1', command: 'pause', by: 'u-vera', line: 2 }]);
    expect(say('u-vera', 'Milo, leave.')).toEqual([{ type: 'command', callId: 'call-1', command: 'dismiss', by: 'u-vera', line: 3 }]);
    expect(wait(10_000)).toEqual([]);
  });

  it('a fresh mention closes the same speaker\'s earlier request and opens a new one', () => {
    say('u-vera', 'Milo, list the open items.');
    const e = say('u-vera', 'Milo, what is the budget status?', 600);
    expect(requests(e)).toHaveLength(1);
    expect((requests(e)[0] as { text: string }).text).toBe('list the open items.');
    expect((requests(wait(DETECTOR_LIMITS.quietMs))[0] as { text: string }).text).toBe('what is the budget status?');
  });
});

describe('caps', () => {
  it('closes at 12 captions', () => {
    say('u-vera', 'Milo, write the long incident report and');
    let last: DetectorEvent[] = [];
    for (let i = 0; i < 11; i++) last = say('u-vera', `part ${i + 1} and`, 200);
    expect(requests(last)).toHaveLength(1);
    expect((requests(last)[0] as { lines: number[] }).lines).toHaveLength(12);
    expect(d.hasOpen('u-vera')).toBe(false);
  });

  it('closes at 60 s even though the speaker keeps going', () => {
    say('u-vera', 'Milo, narrate the incident and');
    let closed: DetectorEvent[] = [];
    for (let i = 0; i < 6 && !closed.length; i++) closed = say('u-vera', `and then step ${i} and`, 10_000 - 1);
    expect(requests(closed)).toHaveLength(1);
    expect(d.hasOpen('u-vera')).toBe(false);
  });
});

describe('nameLock', () => {
  const l = (userId: string, text: string, at: number, speakers?: string[]): TranscriptLine =>
    ({ callId: 'call-1', seq: 1, userId, participantId: '', speakerName: userId, text, at, captionId: `c${at}`, ...(speakers ? { speakers } : {}) });

  it('true when the person addressed the name inside the window, false outside it or for someone else', () => {
    const lines = [l('u-vera', 'Milo, list the open items.', 100_000)];
    expect(nameLock(lines, 'u-vera', 110_000)).toBe(true);
    expect(nameLock(lines, 'u-vera', 120_000)).toBe(true);
    expect(nameLock(lines, 'u-vera', 120_001)).toBe(false);
    expect(nameLock(lines, 'u-vera', 99_999)).toBe(false);
    expect(nameLock(lines, 'u-release', 110_000)).toBe(false);
  });
  it('a line without an addressing mention does not lock', () => {
    expect(nameLock([l('u-vera', 'I think Milo could help with that budget question', 100_000)], 'u-vera', 101_000)).toBe(false);
    expect(nameLock([l('u-vera', 'plain chatter', 100_000)], 'u-vera', 101_000)).toBe(false);
  });
  it('an overlapped line counts for each speaker listed, and a custom window applies', () => {
    const lines = [l('u-vera', 'Milo, what is blocking the release?', 100_000, ['u-vera', 'u-release'])];
    expect(nameLock(lines, 'u-release', 105_000)).toBe(true);
    expect(nameLock(lines, 'u-vera', 105_000)).toBe(true);
    expect(nameLock(lines, 'u-release', 105_000, 1000)).toBe(false);
    expect(nameLock(lines, 'u-other', 105_000)).toBe(false);
  });
});

describe('a word that makes the assistant\'s name part of something else', () => {
  it('is keyed to the name: the grain and the drink for Milo', () => {
    expect(NAME_FORMS['milo']?.notAddress).toEqual(['grain', 'sorghum', 'fields', 'crops', 'drink', 'powder']);
  });
  it('is not an address, even at the start of a sentence', () => {
    expect(findAddress('Milo grain prices are up this year.')).toBeNull();
    expect(findAddress('We drove out. Milo fields were next.')).toBeNull();
    // However a real transcriber writes it (paid run, 14 November: a place at the head of a line was counted as a request).
    expect(findAddress('milo sorghum is what they plant out there')).toBeNull();
    expect(findAddress("Milo powder's tin is empty")).toBeNull();
    expect(findAddress('Mylo crops did well')).toBeNull();
    expect(findAddress('MILO DRINK is on the list')).toBeNull();
  });
  it('the real address forms still address', () => {
    expect(findAddress('Milo, what is on the list?')?.rest).toBe('what is on the list?');
    expect(findAddress('Milo what is the grain forecast?')).not.toBeNull();
    expect(findAddress('Milo, grain prices are the next topic.')?.rest).toBe('grain prices are the next topic.');
    // A word someone could ask the assistant to do is not on the list: "crop" is a request.
    expect(findAddress('Milo crop the screenshot')?.rest).toBe('crop the screenshot');
  });
});

describe('the provider ended the turn', () => {
  // The Live API puts the closing "?" at the start of the next delta, so a finished request reads as cut by its text alone.
  const ended = (userId: string, text: string): DetectorEvent[] =>
    d.push({ callId: 'call-1', seq: ++seq, userId, participantId: `p-${userId}`, speakerName: userId, text, at: now, captionId: `c-${seq}` }, { turnEnded: true });
  it('closes a request at once when the provider ended the turn on it, punctuation or not', () => {
    expect(looksCut('Milo, how much time is left')).toBe(true);
    expect(requests(ended('u-cand', 'Milo, how much time is left'))).toEqual([expect.objectContaining({ text: 'how much time is left', lines: [1] })]);
  });
  it('closes an open request continued on the line the provider ended', () => {
    expect(requests(say('u-cand', 'Milo, can you'))).toHaveLength(0);
    expect(requests(ended('u-cand', 'repeat the question'))).toEqual([expect.objectContaining({ text: 'can you repeat the question', lines: [1, 2] })]);
  });
  it('still waits for an opener of fewer words than a request', () => {
    expect(requests(ended('u-cand', 'Milo, um'))).toHaveLength(0);
    expect(requests(wait(DETECTOR_LIMITS.cutWaitMs))).toHaveLength(1);
  });
  it('without the provider\'s end, an unpunctuated request still waits the long time', () => {
    say('u-cand', 'Milo, how much time is left');
    expect(requests(wait(DETECTOR_LIMITS.quietMs))).toHaveLength(0);
    expect(requests(wait(DETECTOR_LIMITS.cutWaitMs - DETECTOR_LIMITS.quietMs))).toHaveLength(1);
  });
});
