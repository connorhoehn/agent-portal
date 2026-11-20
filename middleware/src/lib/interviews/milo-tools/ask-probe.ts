// Milo's interview tool `ask_probe`: the lead or a panel member asks Milo to ask the candidate a probe about a topic ("Milo, can
// you ask a probe about the non-functional requirements in this part of the design?"), and Milo asks the candidate one short
// question aloud. Never the candidate: `mayAsk` refuses them with a fixed sentence, whatever a model chose.
//
// The question is written by probe.ts from what the candidate's side may hold and checked there before it is logged; a question
// that fails the check, or none, is the fixed line `PROBE_NONE`. Offered through the turn owner only (milo-turn.ts `toolsFor`).
import type { ServerToolDef } from '../../meeting-assistant/server-tools.js';
import { trace } from '../../meeting-assistant/trace.js';
import type { SaidSource } from '../speak/store.js';
import type { PadLanguage } from '../types.js';
import { hasPad } from './context.js';
import { deps, standingOf, type MiloInterview } from './deps.js';
import { boardOutline } from './board-outline.js';
import { boardLabels, boardRegion, checkProbe, PROBE_HEARD_LINES, PROBE_INTERVIEWERS_ONLY, PROBE_NONE, PROBE_TOPIC_MAX, type ProbeInput } from './probe.js';

export const ASK_PROBE: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'ask_probe',
  description: 'Ask the candidate one short probing question aloud. Use it when the speaker, an interviewer, asks Milo to ask a probe, to probe, to dig into or to ask the candidate a follow-up question about something. topic: what to probe, in the speaker\'s own words (empty when they named nothing).',
  parameters: { type: 'object', properties: { topic: { type: 'string', description: 'What the probe is about, in the speaker\'s words.' } }, required: ['topic'], additionalProperties: false },
  says: 'Asks the candidate one probing question about the topic, written from the question, the board or pad and the talk.',
  mapsTo: 'server: lib/interviews/milo-tools ask_probe',
  writes: false,
  spend: 'tools',
  // The old live session keeps the tools it had: this one is the turn owner's.
  offered: () => false,
  mayAsk: async (interview, askedBy) => {
    const standing = await standingOf(interview, askedBy);
    if (!standing) return null;
    return standing === 'candidate' ? { refusal: PROBE_INTERVIEWERS_ONLY } : true;
  },
  run: async (interview, _askedBy, args) => {
    const d = deps();
    const raw = (args as { topic?: unknown } | null)?.topic;
    const topic = (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '').slice(0, PROBE_TOPIC_MAX);
    const t0 = Date.now();
    const [questions, elements, heard, key] = await Promise.all([
      d.questions(interview).catch(() => []),
      interview.surface === 'board' ? d.board(interview).catch(() => null) : Promise.resolve(null),
      d.heard(interview).catch(() => []),
      // The key unread, nothing a model wrote can be checked against it: nothing is said.
      d.answerKey(interview).catch(() => null),
    ]);
    if (key === null) return { line: PROBE_NONE, kind: 'refusal' };
    let pad: { text: string; language: PadLanguage } | null = null;
    if (hasPad(interview)) await d.write(interview.id, ({ text, language }) => { pad = { text, language }; return null; }).catch(() => null);
    const seen = pad as { text: string; language: PadLanguage } | null;
    const readMs = Date.now() - t0;
    // The kit's starting board is left out of the outline: what is described is what the candidate drew.
    const template = new Set(questions.flatMap((q) => (q.board?.elements ?? []).map((e) => String((e as Record<string, unknown>)['id']))));
    const input: ProbeInput = {
      topic, questions, surface: interview.surface, board: elements ? boardRegion(elements) : null, outline: elements ? boardOutline(elements, { template }) : null,
      pad: seen, heard: heard.slice(-PROBE_HEARD_LINES),
    };
    const written = await d.prober(interview, input).catch(() => null);
    // Where a probe's time goes (film 4: 5.9 s to his first word): reading the room's surfaces, then writing the question.
    trace('probe.write', { readMs, writeMs: Date.now() - t0 - readMs, surface: interview.surface ?? 'none', pad: seen !== null, outline: input.outline ? input.outline.length : 0 });
    const visible = [
      topic, ...questions.flatMap((q) => [q.prompt, ...q.followUps, ...(q.clarifying ?? [])]), ...(elements ? boardLabels(elements) : []),
      ...(seen ? [seen.text] : []), ...heard.map((l) => l.text),
    ];
    const line = written === null ? null : checkProbe(written, key, visible);
    return line === null ? { line: PROBE_NONE, kind: 'refusal' } : { line, kind: 'probe' };
  },
};
