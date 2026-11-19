// The whiteboard's name on the wire (WHITEBOARD-PLAN step 1): a system design round's board is one shared Yjs
// document on the BFF's realtime gateway, carried by the same `collabDocs` feature as the code pad
// (../pad/feature.ts): document id `ivboard:<interviewId>`, channel `doc:ivboard:<interviewId>`. The library caps a
// document channel at 50 characters, so an interview id may be at most 38 here (a UUID is 36). Inside, the
// Excalidraw scene is the library binding's root map (`excalidraw`), the same as Work's whiteboards.
//
// Mirrored by portal/src/lib/interviewsBoard.ts, whose test pins the names by value.

export const BOARD_DOCUMENT_PREFIX = 'ivboard:';
const DOC = 'doc:';
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,37}$/;

/** The board's document id, or null for an id that cannot name one. */
export function boardDocumentId(interviewId: string): string | null {
  return INTERVIEW_ID.test(interviewId) ? `${BOARD_DOCUMENT_PREFIX}${interviewId}` : null;
}

/** The board's channel, `doc:ivboard:<interviewId>`, or null. */
export function boardChannel(interviewId: string): string | null {
  const id = boardDocumentId(interviewId);
  return id ? `${DOC}${id}` : null;
}

/** The interview a board channel names, or null for anything else (a pad, another document, a malformed id). */
export function boardInterviewId(channel: string): string | null {
  if (!channel.startsWith(`${DOC}${BOARD_DOCUMENT_PREFIX}`)) return null;
  const id = channel.slice(DOC.length + BOARD_DOCUMENT_PREFIX.length);
  return INTERVIEW_ID.test(id) ? id : null;
}
