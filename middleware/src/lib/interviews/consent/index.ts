// The consents module (docs/interviews-tenant-plan.md decision 5, row I2.3; contract C4).
//
// Two reads for the rest of the tenant, wired at combine (C8): the knock precondition takes
// `knockCheck` (consentsAnswered plus the deployment's required parts), Milo's policy takes `consentsFor`. Both run inside the interviews tenant's db context.
//
//   consentsAnswered  true only when all three answers are stored under the CURRENT notice. Answers under an
//                     older notice do not count: the candidate is asked again before they can knock.
//   consentsFor       the stored answers, whatever notice they were given under (they are what the candidate
//                     agreed to), or null when nothing was answered. Null means nothing may run.

import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { CONSENT_NOTICE } from './notice.js';
import { consentStore } from './store.js';
import { declinedRequired, requiredConsents } from './required.js';

export { CONSENT_NOTICE, type ConsentNotice } from './notice.js';
export { CONSENT_PARTS, checkAnswers, consentsChangeable, partsOff, stampAnswers, type ConsentAnswers, type ConsentPart } from './rules.js';
export { consentStore, setConsentStore, type ConsentRecord, type ConsentStore } from './store.js';
export { declinedRequired, requiredConsents, REQUIRED_CONSENTS_SETTING } from './required.js';

/**
 * The knock's precondition (C8, extended by row I6.4): yes once the current notice is answered and the answers leave
 * no required part off. `unanswered` when nothing counts yet; `declined-required` when a part this deployment requires
 * was declined (the answer stands; the call cannot start as set up until it changes).
 */
export async function knockCheck(interviewId: string): Promise<true | 'unanswered' | 'declined-required'> {
  const record = await runWithDbTenant(INTERVIEWS_TENANT, () => consentStore().getConsent(interviewId));
  if (!record || record.noticeVersion !== CONSENT_NOTICE.version) return 'unanswered';
  return declinedRequired(record, requiredConsents()).length ? 'declined-required' : true;
}

export async function consentsAnswered(interviewId: string): Promise<boolean> {
  const record = await runWithDbTenant(INTERVIEWS_TENANT, () => consentStore().getConsent(interviewId));
  return record !== null && record.noticeVersion === CONSENT_NOTICE.version;
}

export async function consentsFor(interviewId: string): Promise<{ recording: boolean; transcription: boolean; milo: boolean } | null> {
  const record = await runWithDbTenant(INTERVIEWS_TENANT, () => consentStore().getConsent(interviewId));
  if (!record) return null;
  // Milo needs the transcript: held here too, whatever a row says.
  return { recording: record.recording, transcription: record.transcription, milo: record.transcription && record.milo };
}

// The two hooks other modules leave open for consent (round 3, C8): a guest may knock only once the current notice
// is answered (and, since row I6.4, leaves no required part off), and Milo hears a guest only when the transcript and
// Milo were both accepted.
import { setKnockPrecondition } from '../invite/admission.js';
import { setInterviewConsentSource } from '../milo-policy.js';
setKnockPrecondition(knockCheck);
setInterviewConsentSource(consentsFor);
