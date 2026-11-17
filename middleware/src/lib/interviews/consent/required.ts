// Which consents this deployment requires (docs/interviews-tenant-plan.md decision 5, row I6.4; contract F3).
//
//   INTERVIEWS_REQUIRED_CONSENTS   a comma list drawn from `recording`, `transcription`, `milo`. Default empty: decision 5
//                                  as written, declining is allowed and the interview runs without that part.
//
// A required part changes one thing: a guest whose current answers decline it may not knock (invite/admission.ts),
// and the lead may not let them in, so the interview cannot start as it is set up. Declining stays allowed: the answer
// is stored and stamped exactly as any other (rules.ts), the candidate reads why the call cannot start, and the
// recruiter's bell and Consent column say the round cannot go ahead as set. The lead is still told only what is off.
//
// `milo` required implies `transcription` required: Milo reads the transcript, so with it declined Milo is off too.
// Unknown words are ignored, with one warning per value. Read on every use, so a change needs no restart. Never throws.

import { CONSENT_PARTS, type ConsentAnswers, type ConsentPart } from './rules.js';
import { partsOffOf } from './effects.js';

export const REQUIRED_CONSENTS_SETTING = 'INTERVIEWS_REQUIRED_CONSENTS';

const warned = new Set<string>();
/** Test seam: forget which values were already reported. */
export function resetRequiredWarnings(): void { warned.clear(); }

const KNOWN: ReadonlySet<string> = new Set(CONSENT_PARTS);

/** The parts this deployment requires now, in the notice's order. Empty by default. */
export function requiredConsents(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (l) => console.warn(l)): ConsentPart[] {
  const raw = env[REQUIRED_CONSENTS_SETTING]?.trim();
  if (!raw) return [];
  const words = raw.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const unknown = words.filter((w) => !KNOWN.has(w));
  if (unknown.length) {
    const once = `${REQUIRED_CONSENTS_SETTING}=${raw}`;
    if (!warned.has(once)) {
      warned.add(once);
      warn(`[interviews] ${REQUIRED_CONSENTS_SETTING} may name only recording, transcription and milo; ignoring ${unknown.map((w) => JSON.stringify(w)).join(', ')}.`);
    }
  }
  const asked = new Set(words.filter((w) => KNOWN.has(w)) as ConsentPart[]);
  if (asked.has('milo')) asked.add('transcription');
  return CONSENT_PARTS.filter((p) => asked.has(p));
}

/**
 * The required parts the answers leave off. Pure. No answers yet declines nothing here (the knock is already refused
 * for unanswered consents, for its own reason).
 */
export function declinedRequired(answers: ConsentAnswers | null, required: readonly ConsentPart[]): ConsentPart[] {
  if (!answers || !required.length) return [];
  const off = new Set<string>(partsOffOf(answers));
  return required.filter((p) => off.has(p));
}
