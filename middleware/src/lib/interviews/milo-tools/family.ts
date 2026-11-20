// Milo's interview tools as one server-tool family (meeting-assistant/server-tools.ts): the six tools, in the order the live session
// is offered them, and what is about the interview rather than one tool: the interview behind a call (a LIVE one), what the
// background agent is told (the round's coding questions as the thing not to solve, and the pad as the session starts), the
// fallback sentence for what THIS asker may ask, and the said log. Importing this module registers the family.
import { registerServerTools, registeredServerTools, type ServerToolFamily, type ToolSaid } from '../../meeting-assistant/server-tools.js';
import { interviewOfLobby } from './call.js';
import { MILO_CAN_DO } from '../speak/index.js';
import type { SaidSource } from '../speak/store.js';
import type { PadLanguage, RoundSurface } from '../types.js';
import { hasPad, interviewBackendInstructions } from './context.js';
import { candidateMayAsk, deps, liveInterview, logLine, NO_BOARD, ON_IT, PAD_BUSY, PAD_FAILED, standingOf, type MiloInterview, type Standing } from './deps.js';
import { INTRODUCE } from './introduce.js';
import { PAD_ADD_HELPER } from './pad-add-helper.js';
import { PAD_ADD_IMPORT } from './pad-add-import.js';
import { PAD_ADD_TESTS } from './pad-add-tests.js';
import { TURN_PAD_TOOLS } from './pad-request.js';
import { notePadSeen } from './pad-notes.js';
import { REPEAT_QUESTION } from './repeat-question.js';
import { TIME_LEFT } from './time-left.js';

/**
 * What this asker may ask for, said when Milo heard a request it could not serve (the family's `whatICanDo`), by where the round
 * is worked: the pad tools on the code pad only; on the whiteboard the lead also hears that Milo cannot add to the board yet.
 */
export function whatICanDo(standing: Standing, padHelp: boolean, surface: RoundSurface | null): string | null {
  if (standing === 'panel') return null;
  const padRound = surface === 'pad';
  if (standing === 'candidate' && !(padHelp && padRound)) return null; // the candidate's own fixed sentence (speak/index.ts MILO_CAN_DO)
  const plain = 'I can introduce myself, repeat the question or tell you how much time is left.';
  if (!padRound) return surface === 'board' ? `${plain} ${NO_BOARD}` : plain;
  return standing === 'lead'
    ? "I can add test cases, imports or a helper to the pad, introduce myself, or tell you how much time is left. I can't write the solution."
    : "I can repeat the question, tell you how much time is left, or add test cases, imports or a helper to the pad. I can't write the solution.";
}

/** The fallback for this asker in this interview: what they may ask; `candidateLine` for the candidate without pad help; null for a panel member or a stranger. */
export async function whatICanDoIn(interview: MiloInterview, askedBy: string, candidateLine: string): Promise<string | null> {
  const standing = await standingOf(interview, askedBy);
  if (!standing || standing === 'panel') return null;
  const padHelp = standing === 'lead' || (await candidateMayAsk(interview));
  return whatICanDo(standing, padHelp, interview.surface) ?? candidateLine;
}

/**
 * What the background agent is told: the round's questions and the pad as it is now (read through Milo's own seat, which writes
 * nothing). The pad seen is noted, so a later change of its language is told the session (pad-notes.ts).
 */
async function backendInstructions(interview: MiloInterview): Promise<string> {
  const d = deps();
  const pad = hasPad(interview);
  let seen: { text: string; language: PadLanguage } | null = null;
  if (pad) await d.write(interview.id, ({ text, language }) => { seen = { text, language }; return null; }).catch(() => null);
  // What the session starts with: a later change of the pad is told it (notePadChange).
  const start = seen as { text: string; language: PadLanguage } | null;
  if (start) notePadSeen(interview.id, start);
  const questions = pad ? await d.questions(interview).catch(() => []) : [];
  return interviewBackendInstructions(questions, seen);
}

export const INTERVIEW_TOOL_FAMILY: ServerToolFamily<MiloInterview, SaidSource> = {
  family: 'interviews:interview',
  tenants: ['interviews'],
  // The six the old live session is offered, then the turn owner's pad tools (pad-request.ts), which no session is ever offered.
  tools: [TIME_LEFT, REPEAT_QUESTION, INTRODUCE, PAD_ADD_TESTS, PAD_ADD_IMPORT, PAD_ADD_HELPER, ...TURN_PAD_TOOLS],
  context: async (call) => {
    const interviewId = interviewOfLobby(call.lobby);
    return interviewId ? liveInterview(interviewId) : null;
  },
  backendInstructions,
  whatICanDo: (interview, askedBy) => whatICanDoIn(interview, askedBy, MILO_CAN_DO),
  log: async (interview, askedBy, said) => { await logLine(interview, askedBy, { line: said.line, source: said.kind }); },
  busy: PAD_BUSY,
  failed: PAD_FAILED,
  acknowledgement: ON_IT,
  now: () => deps().now(),
};

registerServerTools(INTERVIEW_TOOL_FAMILY);

/** The interview tools as registered (name, schema, `writes`, the family and its tenants). */
export const INTERVIEW_TOOLS = registeredServerTools(INTERVIEW_TOOL_FAMILY.family);
