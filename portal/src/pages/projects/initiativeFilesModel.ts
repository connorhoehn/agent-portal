// The Docs tab's New menu (docs/voice-navigator-gaps.md G56): which choices a
// persona sees, and what the voice is told it can make here (G55). No React;
// unit-tested alone.
//
//   Document, Whiteboard  the initiative's own people: its owner, a contributor or
//                         an org-wide role, with ViewWorkItems. The page cannot
//                         see who is on the initiative, so it asks the route that
//                         decides: GET …/workspace-documents answers `canWrite`.
//   Presentation          a status deck, which spends: DispatchAgentRun (the deck
//                         write rule, lib/deck-shared/authority.ts).
//
// Hiding is all this does; POST …/workspace-documents and POST
// /api/initiative-decks/projects/:id refuse on their own.

import type { PageOffer } from '../../lib/voice/pageContext';

export type NewFileChoice = 'document' | 'whiteboard' | 'presentation';

/** The route's `canWrite` from the workspace-documents list read; anything but `true` is no. */
export function readCanWrite(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as Record<string, unknown>)['canWrite'] === true;
}

export function newFileChoices(o: { capabilitiesReady: boolean; canWritePages: boolean; canDispatch: boolean }): NewFileChoice[] {
  return [
    ...(o.canWritePages ? (['document', 'whiteboard'] as const) : []),
    ...(o.capabilitiesReady && o.canDispatch ? (['presentation'] as const) : []),
  ];
}

const OFFER: Record<NewFileChoice, PageOffer> = {
  document: { label: 'Document', tool: 'create', kind: 'document' },
  whiteboard: { label: 'Whiteboard', tool: 'create', kind: 'whiteboard' },
  presentation: { label: 'Presentation (a PowerPoint status deck)', tool: 'queue_work', kind: 'deck' },
};

/** The page-context offers for the choices shown: each with the voice call that makes the same thing. */
export const newFileOffers = (choices: readonly NewFileChoice[]): PageOffer[] => choices.map((c) => OFFER[c]);

/** Beside the disabled New file trigger, when this viewer may create nothing here. */
export const NEW_FILE_DENIED_HINT = 'Only this initiative’s people and org-leaders add files here.';

/** The New file trigger stays drawn; it is enabled only when there is a choice to make. */
export const newFileTrigger = (choices: readonly NewFileChoice[]): { disabled: boolean } => ({ disabled: choices.length === 0 });

/** The hint shows once both reads have settled and the viewer may create nothing (not while still loading). */
export const showNewFileHint = (o: { capabilitiesReady: boolean; pending: boolean; choices: readonly NewFileChoice[] }): boolean =>
  o.capabilitiesReady && !o.pending && o.choices.length === 0;

export const RECORDINGS_NEED_SOCIAL = 'Recordings need the Social workspace.';

/**
 * Whether the Docs tab reads recordings. Recordings live in the Social
 * workspace: a persona without ViewSocial gets an info line and no read (the
 * read would only fail into a warning). While capabilities load, no read and no line.
 */
export function recordingsMode(o: { capabilitiesReady: boolean; canViewSocial: boolean }): 'pending' | 'read' | 'needs-social' {
  if (!o.capabilitiesReady) return 'pending';
  return o.canViewSocial ? 'read' : 'needs-social';
}
