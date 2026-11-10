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
/** Why a work item's controls are read-only to a viewer whose role could edit work but who is not on this initiative. */
export const WORK_EDIT_DENIED_HINT = 'Only this initiative’s people and org-leaders change its work.';

/** The New file trigger stays drawn; it is enabled only when there is a choice to make. */
export const newFileTrigger = (choices: readonly NewFileChoice[]): { disabled: boolean } => ({ disabled: choices.length === 0 });

/** The hint shows once both reads have settled and the viewer may create nothing (not while still loading). */
export const showNewFileHint = (o: { capabilitiesReady: boolean; pending: boolean; choices: readonly NewFileChoice[] }): boolean =>
  o.capabilitiesReady && !o.pending && o.choices.length === 0;

export const RECORDINGS_NEED_SOCIAL = 'Recordings need the Social workspace.';

/**
 * Whether the identity holds a Social role, whatever workspace it acts in now.
 * Every Social role holds ViewSocial (participant, moderator, community-admin:
 * middleware/seeds/roles/social/*.cedar), and the server reads Social through
 * any held Social role, not the active one (lib/live-principal.ts
 * `socialActionRole`). So Sienna, a Social `participant` acting as an orgiq
 * member or org-leader, reads recordings although `can('ViewSocial')` — the
 * active role's answer — is false (walk, 9 November).
 */
export function holdsSocialRole(grants: Readonly<Record<string, readonly string[]>> | null | undefined): boolean {
  return (grants?.['social']?.length ?? 0) > 0;
}

/**
 * Whether the Docs tab reads recordings. Recordings live in the Social
 * workspace: a persona with neither ViewSocial in its active role nor a Social
 * role (`holdsSocialRole`) gets an info line and no read (the read would only
 * fail into a warning). While capabilities load, no read and no line.
 */
export function recordingsMode(o: { capabilitiesReady: boolean; canViewSocial: boolean }): 'pending' | 'read' | 'needs-social' {
  if (!o.capabilitiesReady) return 'pending';
  return o.canViewSocial ? 'read' : 'needs-social';
}

/**
 * The Docs tab's one info line about recordings: why there is no read
 * (RECORDINGS_NEED_SOCIAL), or, when the read was made and failed, the reason
 * it gave ("Recordings: The call recording service is not configured."), so
 * a persona who may read them is never told to go to the Social workspace.
 * Null when there is nothing to say.
 */
export function recordingsNote(mode: ReturnType<typeof recordingsMode>, readError: string | null): string | null {
  if (mode === 'needs-social') return RECORDINGS_NEED_SOCIAL;
  if (mode === 'read' && readError) return `Recordings: ${readError}`;
  return null;
}
