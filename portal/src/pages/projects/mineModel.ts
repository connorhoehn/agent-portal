// The Mine view's model (mockup variant 3): which of four things is true, and
// what the pane says about it. No React; unit-tested alone.
//
//   has-rows     — something lists you; the pane shows the table.
//   unlinked     — your account is not connected to a team profile.
//   linked-none  — connected, and no initiative lists you as owner or SME.
//   error        — a read failed; never shown as "nothing linked" (class 3).
//   loading      — still reading.
//
// The empty copy is only ever reached from rows: the Mine list came back
// empty AND /api/session/person answered.

import type { ProjectSummary, SessionPerson } from './types';

export interface Read<T> {
  data: T | null | undefined;
  error?: string | null;
}

export interface MineInput {
  /** GET /api/graph/projects?scope=mine. */
  list: Read<ProjectSummary[]>;
  /** GET /api/session/person. */
  person: Read<SessionPerson>;
  /** GET /api/graph/people/:id — the connected person's name; null while unread or failed. */
  personName?: string | null;
}

export const MINE_TITLE = 'My initiatives';
export const MINE_DESCRIPTION = 'Initiatives where you are an owner or contributor.';

export interface MineEmptyCopy {
  heading: string;
  lines: string[];
  primary: { label: string; action: 'show-everyone' };
  secondary: { label: string; href: string };
  details: { title: string; lines: string[]; action: { label: string; action: 'refresh' } };
}

export type MineModel =
  | { state: 'loading' }
  | { state: 'error'; failed: 'initiatives' | 'profile'; error: string }
  | { state: 'has-rows'; rows: ProjectSummary[] }
  | { state: 'unlinked'; copy: MineEmptyCopy }
  | { state: 'linked-none'; personId: string; copy: MineEmptyCopy };

export const CHECK_PROFILE_HREF = '/settings#profile';

const HOW_IT_WORKS = {
  title: 'How this view works',
  lines: [
    'An initiative appears here when you are listed as an owner or contributor.',
    'Your account also needs to be connected to your team profile.',
    'A workspace admin can help connect it if needed.',
  ],
  action: { label: 'Refresh this view', action: 'refresh' as const },
};

function copy(lines: string[]): MineEmptyCopy {
  return {
    heading: 'No initiatives are linked to you yet.',
    lines,
    primary: { label: 'Browse all initiatives', action: 'show-everyone' },
    secondary: { label: 'Check profile', href: CHECK_PROFILE_HREF },
    details: HOW_IT_WORKS,
  };
}

export function buildMine(input: MineInput): MineModel {
  if (input.list.error) return { state: 'error', failed: 'initiatives', error: input.list.error };
  if (input.list.data == null) return { state: 'loading' };
  // Rows answer the question on their own; the person read cannot change it.
  if (input.list.data.length > 0) return { state: 'has-rows', rows: input.list.data };

  // Empty — now WHY matters, and only the person read can say.
  if (input.person.error) return { state: 'error', failed: 'profile', error: input.person.error };
  const person = input.person.data;
  if (person == null) return { state: 'loading' };

  if (!person.linked || !person.personId) {
    return {
      state: 'unlinked',
      copy: copy([
        "You can still browse your team's work in Everyone.",
        'If you expected to see your initiatives here, check your profile connection.',
      ]),
    };
  }
  const who = input.personName?.trim();
  return {
    state: 'linked-none',
    personId: person.personId,
    copy: copy([
      who
        ? `You are connected as ${who}, but no initiative lists you as an owner or contributor.`
        : 'Your account is connected to your team profile, but no initiative lists you as an owner or contributor.',
      "You can still browse your team's work in Everyone.",
    ]),
  };
}
