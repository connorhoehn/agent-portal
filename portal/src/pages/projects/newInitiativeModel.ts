// The New initiative form's rules, kept apart from the component so a test can
// pin them. The server (POST /api/graph/projects) repeats every check; these
// only stop a doomed request and word the refusals.

export const NAME_MAX = 80;
export const SUMMARY_MAX = 600;
export const REPO_MAX = 140;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The query parameter that opens the form in the list's content area. */
export const NEW_PARAM = 'new';

export interface NewInitiativeDraft {
  name: string;
  summary: string;
  /** A person id; '' means "me" (the server defaults to the caller). */
  ownerId: string;
  sponsorId: string;
  repo: string;
}

export const EMPTY_DRAFT: NewInitiativeDraft = { name: '', summary: '', ownerId: '', sponsorId: '', repo: '' };

export interface NewInitiativeProblems { name?: string; summary?: string; repo?: string }

export function newInitiativeProblems(draft: NewInitiativeDraft): NewInitiativeProblems {
  const out: NewInitiativeProblems = {};
  const name = draft.name.trim();
  if (!name) out.name = 'Give the initiative a name.';
  else if (name.length > NAME_MAX) out.name = `Keep the name to ${NAME_MAX} characters or fewer.`;
  if (draft.summary.trim().length > SUMMARY_MAX) out.summary = `Keep the summary to ${SUMMARY_MAX} characters or fewer.`;
  const repo = draft.repo.trim();
  if (repo && (repo.length > REPO_MAX || !REPO_RE.test(repo))) out.repo = 'Write the repository as owner/name, for example acme/billing.';
  return out;
}

/** The request body: blank optional fields are left out, so the server's defaults apply. */
export function newInitiativeBody(draft: NewInitiativeDraft, selfId: string | null): Record<string, string> {
  const body: Record<string, string> = { name: draft.name.trim() };
  const summary = draft.summary.trim();
  if (summary) body['summary'] = summary;
  // Naming the caller is the same as naming nobody; send only a real choice.
  if (draft.ownerId && draft.ownerId !== selfId) body['owner_person_id'] = draft.ownerId;
  if (draft.sponsorId) body['sponsor_person_id'] = draft.sponsorId;
  const repo = draft.repo.trim();
  if (repo) body['repo'] = repo;
  return body;
}

/** What a refusal from the server says, and which initiative it points at. */
export interface CreateRefusal { field: 'name' | 'repo' | 'owner' | null; message: string; existingId: string | null }

export function createRefusal(status: number, data: { code?: string; existingId?: string } | null, error: string | null): CreateRefusal {
  const existingId = data?.existingId ?? null;
  if (data?.code === 'NAME_TAKEN') return { field: 'name', message: error ?? 'An initiative with that name already exists.', existingId };
  if (data?.code === 'REPO_LINKED') return { field: 'repo', message: error ?? 'That repository is already linked to an initiative.', existingId };
  if (data?.code === 'NO_SUCH_PERSON') return { field: 'owner', message: error ?? 'That person is not in the directory.', existingId: null };
  if (status === 403) return { field: null, message: 'Your role cannot start an initiative.', existingId: null };
  return { field: null, message: error ?? 'The initiative could not be created.', existingId: null };
}
