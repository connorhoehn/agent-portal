// The coach's model (docs/interviews-tenant-plan.md decision 7, row I3.3): Amazon Nova through Bedrock's Converse API, or a
// scripted stand-in chosen the way lib/meeting-assistant/session-select.ts chooses (the mock world scripts it unless
// MEETING_ASSISTANT_LIVE=1 asks for the real one), so tests and walks are deterministic and cost nothing.
//
// Rules kept here, as lib/meeting-assistant/decision-model.ts keeps them:
//   * a short timeout and at most one retry; a failure is a code, never an exception to the caller;
//   * nothing of the transcript, the prompt or the answer is logged: only codes;
//   * the call itself goes through the tenant's one Bedrock seam (../bedrock.ts);
//   * the model returns raw text; parse.ts reads it, the same way for both models, so the stand-in walks the real path.
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { converseOnce, refusedBeforeRunning, type ConverseSend } from '../bedrock.js';
import { liveForced } from '../../meeting-assistant/live-flag.js';
import { mockTranscriptEnabled } from '../../meeting-assistant/transcript-source.js';
import { buildCoachRequest, coachUserText, COACH_SYSTEM_PROMPT, MAX_BASED_ON_CHARS, type CoachInput } from './prompt.js';
import { codeStage, fitsStage } from './stage.js';

/** Nova Pro: the coach's words reach a person judging another person, so it gets the stronger of the two text models. */
export const DEFAULT_COACH_MODEL_ID = 'amazon.nova-pro-v1:0';
export const SCRIPTED_COACH_MODEL_ID = 'scripted-coach';
/** One suggestion should come back well inside the 90 seconds between suggestions; the lead is mid-conversation. */
export const COACH_TIMEOUT_MS = 10_000;

/** `INTERVIEWS_COACH_MODEL_ID`: the deployment's Bedrock model for the coach (an Amazon Nova text model), else Nova Pro. */
export function coachModelId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env['INTERVIEWS_COACH_MODEL_ID'] ?? '').trim();
  return /^[A-Za-z0-9.:_-]{3,120}$/.test(raw) ? raw : DEFAULT_COACH_MODEL_ID;
}

export interface TokenCounts { inputTokens: number; outputTokens: number }
export interface CoachModelResult {
  /** The model's text, or null when nothing came back. */
  raw: string | null;
  /** `nothing`: the stand-in has nothing left to suggest. */
  code: 'ok' | 'nothing' | 'timeout' | 'error';
  /** The request reached the provider (so it may have cost something). */
  sent: boolean;
  /** The provider's own counts, when it gave them. */
  usage: TokenCounts | null;
}

export interface CoachModel {
  readonly kind: 'bedrock' | 'scripted';
  readonly modelId: string;
  suggest(input: CoachInput): Promise<CoachModelResult>;
}

/** About four characters a token, plus the answer's usual size: what a hold is sized from. */
export function estimateCoachTokens(input: CoachInput): TokenCounts {
  const chars = COACH_SYSTEM_PROMPT.length + 800 + coachUserText(input).length;
  return { inputTokens: Math.ceil(chars / 4), outputTokens: 120 };
}

export { refusedBeforeRunning };

export class BedrockCoachModel implements CoachModel {
  readonly kind = 'bedrock' as const;
  readonly modelId: string;
  constructor(private readonly opts: { send?: ConverseSend; timeoutMs?: number; modelId?: string } = {}) {
    this.modelId = opts.modelId ?? coachModelId();
  }

  suggest(input: CoachInput): Promise<CoachModelResult> {
    // A refusal (no access, bad credentials, a throttle, a bad request) ran no model and bills nothing, so no spend is
    // booked for it; a timeout or a server-side failure may have run, so it is booked at the estimate as before.
    return converseOnce(buildCoachRequest(this.modelId, input) as ConverseCommandInput,
      { send: this.opts.send, timeoutMs: this.opts.timeoutMs ?? COACH_TIMEOUT_MS, label: 'coach', refusalBooksNothing: true });
  }
}

// ---- the scripted stand-in --------------------------------------------------------------------------------------------------------
//
// Deterministic, from the kit and the transcript it is given, never from meaning. It stays inside the round (E4 finding
// 41): the round's competencies are those of the questions the lead chose (all of the bank's when none were chosen).
//   1. a follow-up that fits the last thing the candidate said: of the questions asked or suggested, the first follow-up
//      not yet suggested or asked that shares the most content words with the candidate's last line (compared by stem,
//      a pair of neighbouring words also read as one, so "fail over" meets "failover"); it quotes that line;
//   2. the next chosen question not yet asked or suggested;
//   3. with nothing chosen: the first competency not covered (an earlier suggestion tied to it, or one of its bank
//      questions asked), with its first bank question neither suggested nor asked;
//   4. the first remaining follow-up of an asked or suggested question;
//   5. nothing left: no answer (`nothing`).
// In a technical round no step offers a question about complexity before working code, or about testing before a run
// (stage.ts `fitsStage`).
// Steps 2 to 4 are not keyed to a line and quote none. A question counts as asked when a panel line or the pad holds its
// opening words (its first six; the whole prompt when another bank question opens the same way), as whole words, when
// one panel line holds at least half of its content words, or when the lead posted it into the pad (the pad log's insert,
// which arrives within seconds; the pad's text arrives only in a snapshot every 30 seconds). A panel line is read with
// the short first fragment of the line after it, since a live transcript can credit a question's last word to the
// candidate ("So, what's the runtime" / "complexity? Oh! It's linear time.").

const words = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
/** A question's opening words (its first six). */
const opening = (s: string): string => words(s).split(' ').slice(0, 6).join(' ');
/** Does `line` hold `needle` as whole words ("two sum" is not in "two_summary")? */
const said = (needle: string, line: string): boolean => needle.length > 0 && ` ${words(line)} `.includes(` ${needle} `);

const STOP = new Set(('what that this with about they them their there have does when where which were been from your would could should '
  + 'tell more much some then than into also just like only very will want know here doing done happens happen time first next').split(' '));
const stem = (w: string): string => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  const t = w.replace(/(?:ing|ed|es|s|e)$/, '');
  return t.length >= 3 ? t : w;
};
/** Content words (four letters or more, common words out), stemmed, plus each neighbouring pair joined when one is content. */
function contentOf(s: string): Set<string> {
  const w = words(s).split(' ').filter(Boolean);
  const content = (x: string) => x.length >= 4 && !STOP.has(x);
  return new Set([...w.filter(content).map(stem), ...w.slice(1).flatMap((b, i) => (content(w[i]!) || content(b) ? [stem(`${w[i]}${b}`)] : []))]);
}
const overlap = (a: Set<string>, b: Set<string>): number => [...a].filter((x) => b.has(x)).length;
/** Content words only (no joined pairs): what "half of its words" counts. */
const plainContent = (s: string): Set<string> => new Set(words(s).split(' ').filter((x) => x.length >= 4 && !STOP.has(x)).map(stem));

function quoteOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 200) return t;
  const cut = t.slice(0, 200);
  const space = cut.lastIndexOf(' ');
  return space > 40 ? cut.slice(0, space) : cut;
}

/**
 * What marks a question as said: its opening words, or its whole prompt when another bank question opens the same way
 * (then the opening alone cannot tell them apart).
 */
function cueOf(input: CoachInput, prompt: string): string {
  const open = opening(prompt);
  const whole = words(prompt);
  return input.questions.some((q) => words(q.prompt) !== whole && opening(q.prompt) === open) ? whole : open;
}

/** At most this many words of the next line's first sentence are read as the end of a panel line (panelReads). */
export const SPILL_WORDS = 3;

/**
 * The panel's lines as the coach reads them for "asked": each one, joined to the first sentence of the line right after it
 * when that line is someone else's and its first sentence is a fragment of at most SPILL_WORDS words. A live transcript
 * places a speaker change a second or so off, so the question's last word can open the answer's line.
 */
function panelReads(lines: CoachInput['lines']): string[] {
  return lines.flatMap((l, i) => {
    if (l.side !== 'panel') return [];
    const next = lines[i + 1];
    if (!next || next.side === 'panel' || next.seq !== l.seq + 1) return [l.text];
    const head = /^[^.?!]*[.?!]/.exec(next.text)?.[0] ?? '';
    const n = words(head).split(' ').filter(Boolean).length;
    return [n > 0 && n <= SPILL_WORDS ? `${l.text} ${head}` : l.text];
  });
}

/**
 * Has this question been asked? A panel line (panelReads) holds its cue (cueOf) or half of its content words; the lead
 * posted it into the pad (the pad log's insert of its id); or the pad's snapshot holds its cue (the Prepare insert posts
 * the prompt there as a wrapped comment; `words` drops the comment marks and joins the lines); never a mere overlap with
 * the pad's code.
 */
export function questionAsked(input: CoachInput, prompt: string): boolean {
  const posted = input.code?.posted;
  if (posted?.length) {
    const whole = words(prompt);
    if (input.questions.some((q) => posted.includes(q.id) && words(q.prompt) === whole)) return true;
  }
  const cue = cueOf(input, prompt);
  const panel = panelReads(input.lines);
  if (panel.some((t) => said(cue, t))) return true;
  const want = plainContent(prompt);
  if (want.size >= 2 && panel.map(plainContent).some((p) => overlap(want, p) * 2 >= want.size)) return true;
  const pad = input.code?.pad?.text;
  return !!pad && said(cue, pad);
}

export function scriptedSuggestion(input: CoachInput): { text: string; competencyId: string; basedOn: string | null } | null {
  const asked = (prompt: string) => questionAsked(input, prompt);
  const suggested = new Set(input.previous.map((p) => p.text.replace(/\s+/g, ' ').trim()));
  // In a technical round, nothing about complexity before working code and nothing about testing before a run (stage.ts).
  const stage = codeStage(input.code);
  const fresh = (text: string) => !suggested.has(text) && !asked(text) && fitsStage(text, stage);
  const chosen = input.chosenQuestionIds;
  const bank = [...input.questions].sort((a, b) => {
    const ia = chosen.indexOf(a.id); const ib = chosen.indexOf(b.id);
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
  });
  const chosenQs = bank.filter((q) => chosen.includes(q.id));
  const round = new Set((chosenQs.length ? chosenQs : bank).map((q) => q.competencyId));
  const inRound = bank.filter((q) => round.has(q.competencyId));
  const open = inRound.filter((q) => asked(q.prompt) || suggested.has(q.prompt));
  const followUps = open.flatMap((q) => q.followUps.filter(fresh).map((f) => ({ text: f, competencyId: q.competencyId })));

  // 1. A follow-up that fits the candidate's last line.
  const lastCandidate = [...input.lines].reverse().find((l) => l.side === 'candidate');
  if (lastCandidate) {
    const heard = contentOf(lastCandidate.text);
    let best: { text: string; competencyId: string } | null = null;
    let most = 0;
    for (const f of followUps) {
      const n = overlap(contentOf(f.text), heard);
      if (n > most) { most = n; best = f; }
    }
    if (best) return { ...best, basedOn: quoteOf(lastCandidate.text).slice(0, MAX_BASED_ON_CHARS) };
  }
  // 2. The next chosen question.
  const next = chosenQs.find((q) => fresh(q.prompt));
  if (next) return { text: next.prompt, competencyId: next.competencyId, basedOn: null };
  // 3. Nothing chosen: the first competency of the round with no question yet.
  if (!chosenQs.length) {
    const covered = new Set(input.previous.map((p) => p.competencyId));
    for (const q of bank) if (asked(q.prompt)) covered.add(q.competencyId);
    for (const c of input.competencies) {
      if (covered.has(c.id) || !round.has(c.id)) continue;
      const q = inRound.find((x) => x.competencyId === c.id && fresh(x.prompt));
      if (q) return { text: q.prompt, competencyId: c.id, basedOn: null };
    }
  }
  // 4. Any follow-up left.
  const f = followUps[0];
  return f ? { ...f, basedOn: null } : null;
}

export class ScriptedCoachModel implements CoachModel {
  readonly kind = 'scripted' as const;
  readonly modelId = SCRIPTED_COACH_MODEL_ID;
  async suggest(input: CoachInput): Promise<CoachModelResult> {
    const s = scriptedSuggestion(input);
    return s ? { raw: JSON.stringify(s), code: 'ok', sent: true, usage: null } : { raw: null, code: 'nothing', sent: true, usage: null };
  }
}

/**
 * `INTERVIEWS_COACH_MODEL=scripted` keeps the coach (and with it Milo's private answers, the recap and the plan, which follow its
 * kind) on the scripted stand-in even when Milo's live session is forced on, for a developer's machine (the recorded film runs the
 * live voice against the mock world without Bedrock). `bedrock` asks for the model. Anything else, or nothing: the default rule
 * (the stand-in under the mock transcript, unless the live session is forced). A production process ignores `scripted`.
 */
export const COACH_MODEL_SETTING = 'INTERVIEWS_COACH_MODEL';
export function coachModelChoice(env: NodeJS.ProcessEnv = process.env): 'scripted' | 'bedrock' {
  const raw = (env[COACH_MODEL_SETTING] ?? '').trim().toLowerCase();
  if (raw === 'scripted' && env['NODE_ENV'] !== 'production') return 'scripted';
  if (raw === 'bedrock') return 'bedrock';
  return mockTranscriptEnabled() && !liveForced(env) ? 'scripted' : 'bedrock';
}

export type CoachModelFactory = () => CoachModel;
export const defaultCoachModelFactory: CoachModelFactory = () =>
  (coachModelChoice() === 'scripted' ? new ScriptedCoachModel() : new BedrockCoachModel());

let factory: CoachModelFactory | null = null;
export function setCoachModelFactory(next: CoachModelFactory | null): void { factory = next; }
export function makeCoachModel(): CoachModel { return (factory ?? defaultCoachModelFactory)(); }
