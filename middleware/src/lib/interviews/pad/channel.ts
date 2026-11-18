// The code pad's name on the wire (docs/interviews-tenant-plan.md, "I0.7 answer").
//
// A technical interview's pad is one shared Yjs document on the BFF's own
// realtime gateway (/ws), carried by realtime-modules' `collabDocs` feature:
// document id `ivpad:<interviewId>`, channel `doc:ivpad:<interviewId>`. The
// library caps a document channel at 50 characters, so an interview id may be
// at most 40 (a UUID is 36). On this gateway every `doc:` name is a pad or
// nothing: no other tenant carries documents here.

export const PAD_DOCUMENT_PREFIX = 'ivpad:';
const DOC = 'doc:';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The pad's document id (what `useYjsDoc({ documentId })` takes), or null for an id that cannot name one. */
export function padDocumentId(interviewId: string): string | null {
  return INTERVIEW_ID.test(interviewId) ? `${PAD_DOCUMENT_PREFIX}${interviewId}` : null;
}

/** The pad's channel, `doc:ivpad:<interviewId>`, or null. */
export function padChannel(interviewId: string): string | null {
  const id = padDocumentId(interviewId);
  return id ? `${DOC}${id}` : null;
}

/** The interview a pad channel names, or null for anything else (another document, a malformed id). */
export function padInterviewId(channel: string): string | null {
  if (!channel.startsWith(`${DOC}${PAD_DOCUMENT_PREFIX}`)) return null;
  const id = channel.slice(DOC.length + PAD_DOCUMENT_PREFIX.length);
  return INTERVIEW_ID.test(id) ? id : null;
}

/** Every document channel on this gateway: the pad's authority decides all of them (and refuses all but pads). */
export const inDocumentNamespace = (base: string): boolean => base.startsWith(DOC);

// Inside the document (mirrored by portal/src/lib/interviewsPad.ts, whose test pins them): the code is the Y.Text `code`, and
// the pad's map `pad` holds the shared `language` every pad on the document follows (python until someone picks one).
export const PAD_TEXT_NAME = 'code';
export const PAD_META_NAME = 'pad';
export const PAD_LANGUAGE_KEY = 'language';
