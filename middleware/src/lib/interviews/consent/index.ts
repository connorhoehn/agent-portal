// The consents module (docs/interviews-tenant-plan.md decision 5, row I2.3; contract C4).
//
// Two reads for the rest of the tenant, wired at combine (C8): the knock precondition takes
// `consentsAnswered`, Milo's policy takes `consentsFor`. Both run inside the interviews tenant's db context.
//
//   consentsAnswered  true only when all three answers are stored under the CURRENT notice. Answers under an
//                     older notice do not count: the candidate is asked again before they can knock.
//   consentsFor       the stored answers, whatever notice they were given under (they are what the candidate
//                     agreed to), or null when nothing was answered. Null means nothing may run.

import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { CONSENT_NOTICE } from './notice.js';
import { consentStore } from './store.js';

export { CONSENT_NOTICE, type ConsentNotice } from './notice.js';
export { CONSENT_PARTS, checkAnswers, consentsChangeable, partsOff, stampAnswers, type ConsentAnswers, type ConsentPart } from './rules.js';
export { consentStore, setConsentStore, type ConsentRecord, type ConsentStore } from './store.js';

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
// is answered, and Milo hears a guest only when the transcript and Milo were both accepted.
import { setKnockPrecondition } from '../invite/admission.js';
import { setInterviewConsentSource } from '../milo-policy.js';
setKnockPrecondition(consentsAnswered);
setInterviewConsentSource(consentsFor);
