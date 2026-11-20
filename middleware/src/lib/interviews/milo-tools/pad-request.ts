// Milo's pad tools on the turn contract (docs/milo-rebuild/REBUILD-REVIEW.md, "Amended phase 1", 1C and risk 10):
//
//   pad_write          one request for the pad, in the asker's words. Decide only routes it; the writer (writer.ts) turns it into one
//                      of the pad tools that already exist, and that tool's own checks run on what was written.
//   confirm_pad_write  the lead's yes to a pad change the CANDIDATE asked for.
//   decline_pad_write  the lead's no.
//
// A candidate's request never writes by itself: what reaches the pad is model-written code, so only the tool choice is enforced in
// code. It waits (one per interview, PAD_CONFIRM_TTL_MS) for the lead, who confirms by voice (these tools are offered to the lead
// while one waits) or through `confirmPadWrite` (the door for a confirm card). The lead and the panel write at once.
//
// None of the three is ever offered to the old live session (`offered` is false): they exist for the turn owner (milo-turn.ts).
import type { ServerToolDef, ToolSaid } from '../../meeting-assistant/server-tools.js';
import type { SaidSource } from '../speak/store.js';
import type { PadLanguage } from '../types.js';
import { hasPad } from './context.js';
import { candidateMayAsk, deps, NO_BOARD, NO_PAD, PAD_FAILED, PAD_OFF, standingOf, type MiloInterview } from './deps.js';
import { argsOf } from './pad-write.js';
import { noArgs } from './schema.js';
import { PAD_TOOLS } from './writer.js';

/** Said to the call when the candidate asked for a pad change: the lead hears what to say. */
export const PAD_WAITS_FOR_LEAD = 'I need the lead interviewer to allow that before I change the pad. Say "Milo, go ahead" to allow it.';
export const NOTHING_TO_CONFIRM = 'There is no pad change waiting to be confirmed.';
export const PAD_CONFIRM_LEAD_ONLY = 'Only the lead interviewer can confirm a change to the pad.';
export const PAD_CHANGE_DECLINED = "Okay, I won't change the pad.";
/** Said when a pad request is for nothing Milo adds (a note, a comment, the answer). */
export const PAD_WRITE_KINDS = "I can add test cases, imports or a helper to the pad. I can't write anything else there.";
/** How long a candidate's pad request waits for the lead. */
export const PAD_CONFIRM_TTL_MS = 120_000;
/** The most of a request that is kept and handed to the writer. */
export const PAD_REQUEST_MAX_CHARS = 400;

export interface PendingPadWrite { text: string; askedBy: string; atMs: number }
// In this process only, as the writing lock and the solution-check count are: a restart forgets a waiting request (it is asked again).
const pending = new Map<string, PendingPadWrite>();
/** Tests: forget every waiting request. */
export function resetPendingPadWrites(): void { pending.clear(); }

/** The candidate's pad request waiting for the lead in this interview, or null (none, or it waited too long). */
export function pendingPadWrite(interviewId: string, nowMs: number = deps().now()): PendingPadWrite | null {
  const p = pending.get(interviewId);
  if (!p) return null;
  if (nowMs - p.atMs > PAD_CONFIRM_TTL_MS) { pending.delete(interviewId); return null; }
  return p;
}

/** Who may ask for a pad change on the turn contract: the lead and the panel; the candidate while the lead's switch is on; a pad round only. */
export async function padRequestMayAsk(interview: MiloInterview, askedBy: string): Promise<true | { refusal: string } | null> {
  const standing = await standingOf(interview, askedBy);
  if (!standing) return null;
  if (!hasPad(interview)) return { refusal: interview.surface === 'board' ? NO_BOARD : NO_PAD };
  if (standing === 'candidate' && !(await candidateMayAsk(interview))) return { refusal: PAD_OFF };
  return true;
}

/** Write what was asked for: the writer picks one pad tool and its arguments; that tool's run checks and writes. */
async function writeAsked(interview: MiloInterview, askedBy: string, text: string): Promise<ToolSaid<SaidSource>> {
  const d = deps();
  // The pad as it is now, read through Milo's own seat (the plan writes nothing).
  let seen: { text: string; language: PadLanguage } | null = null;
  await d.write(interview.id, ({ text: now, language }) => { seen = { text: now, language }; return null; }).catch(() => null);
  const questions = await d.questions(interview).catch(() => []);
  const choice = await d.writer(interview, { text, questions, pad: seen as { text: string; language: PadLanguage } | null }).catch(() => null);
  const def = choice && PAD_TOOLS.find((t) => t.name === choice.name);
  if (!choice || !def) return { line: PAD_WRITE_KINDS, kind: 'refusal' };
  return (await def.run(interview, askedBy, choice.args, 'model')) ?? { line: PAD_FAILED, kind: 'refusal' };
}

/** The lead's answer to the waiting request (the voice tools below, and the door for a confirm card). Null: not the lead. */
export async function confirmPadWrite(interview: MiloInterview, leadId: string, allow: boolean): Promise<ToolSaid<SaidSource> | null> {
  if ((await standingOf(interview, leadId)) !== 'lead') return null;
  const p = pendingPadWrite(interview.id);
  if (!p) return { line: NOTHING_TO_CONFIRM, kind: 'refusal' };
  pending.delete(interview.id);
  if (!allow) return { line: PAD_CHANGE_DECLINED, kind: 'refusal' };
  // The switch as it is now: the lead may have turned pad help off while the request waited.
  const may = await padRequestMayAsk(interview, p.askedBy);
  if (may !== true) return { line: may?.refusal ?? PAD_OFF, kind: 'refusal' };
  return writeAsked(interview, p.askedBy, p.text);
}

const leadOnly = async (interview: MiloInterview, askedBy: string): Promise<true | { refusal: string } | null> => {
  const standing = await standingOf(interview, askedBy);
  if (!standing) return null;
  return standing === 'lead' ? true : { refusal: PAD_CONFIRM_LEAD_ONLY };
};

export const PAD_WRITE: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'pad_write',
  description: 'Put something on the shared code pad because this person asked Milo to (test cases, an import, a helper, a note). `text` is what to write, as they asked for it, in their own words. Never write the code yourself.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: PAD_REQUEST_MAX_CHARS, description: 'What to write, as asked.' } },
    required: ['text'], additionalProperties: false,
  },
  says: 'Adds test cases, imports or a helper to the pad as Milo; a candidate\'s request waits for the lead.',
  mapsTo: 'server: lib/interviews/milo-tools pad_write (the turn owner only)',
  writes: true,
  spend: 'tools',
  offered: () => false,
  mayAsk: padRequestMayAsk,
  run: async (interview, askedBy, args) => {
    const raw = argsOf(args)['text'];
    const text = typeof raw === 'string' ? raw.trim().slice(0, PAD_REQUEST_MAX_CHARS) : '';
    if (!text) return { line: PAD_WRITE_KINDS, kind: 'refusal' };
    if ((await standingOf(interview, askedBy)) !== 'candidate') return writeAsked(interview, askedBy, text);
    pending.set(interview.id, { text, askedBy, atMs: deps().now() });
    if (pending.size > 500) pending.delete(pending.keys().next().value as string);
    return { line: PAD_WAITS_FOR_LEAD, kind: 'ack' };
  },
};

export const CONFIRM_PAD_WRITE: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'confirm_pad_write',
  description: 'The lead interviewer allows the pad change the candidate asked Milo for ("go ahead", "yes, do that", "that\'s fine").',
  parameters: noArgs(),
  says: 'Writes the pad change the candidate asked for, once the lead allows it.',
  mapsTo: 'server: lib/interviews/milo-tools confirm_pad_write (the turn owner only)',
  writes: true,
  spend: 'tools',
  offered: () => false,
  mayAsk: leadOnly,
  run: (interview, askedBy) => confirmPadWrite(interview, askedBy, true),
};

export const DECLINE_PAD_WRITE: ServerToolDef<MiloInterview, SaidSource> = {
  name: 'decline_pad_write',
  description: 'The lead interviewer refuses the pad change the candidate asked Milo for ("no", "don\'t", "not now").',
  parameters: noArgs(),
  says: 'Drops the pad change the candidate asked for.',
  mapsTo: 'server: lib/interviews/milo-tools decline_pad_write (the turn owner only)',
  writes: false,
  spend: null,
  offered: () => false,
  mayAsk: leadOnly,
  run: (interview, askedBy) => confirmPadWrite(interview, askedBy, false),
};
