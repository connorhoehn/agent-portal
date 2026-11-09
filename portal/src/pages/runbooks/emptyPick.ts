// The Proposals and Briefs panes with nothing open (UX walk, 9 November 2026,
// defect 22): "Choose a proposal" beside a folded list rail read as a bare
// empty page. Each now says what fills it and offers the one action that does:
// open the newest record when there is one, else go where records come from.
// No React — node:test runs it.

export interface EmptyPick { title: string; description: string; action: { label: string; href: string } | null }

/** Proposals: the first open one (the list leads with Open), else the newest decided one, else the library. */
export function proposalsEmpty(rows: ReadonlyArray<{ id: string; groupId: 'open' | 'decided' }>, href: (id: string) => string, libraryHref: string): EmptyPick {
  const open = rows.find((r) => r.groupId === 'open');
  if (open) return { title: 'Choose a proposal', description: 'Each proposal is an edit or a new runbook waiting for a reviewer: pick one from the list to read its diff.', action: { label: 'Open the first open proposal', href: href(open.id) } };
  if (rows[0]) return { title: 'Nothing to review', description: 'Every proposal has been decided. Pick one from the list to read its diff and the decision.', action: { label: 'Open the latest proposal', href: href(rows[0].id) } };
  return { title: 'No proposals yet', description: 'A run, or a colleague reading a runbook, suggests an edit from the runbook\'s page; it waits here for a reviewer.', action: { label: 'Open the runbook library', href: libraryHref } };
}

/** Briefs: the newest run's brief (rows come newest day first), else the runs that write them. */
export function briefsEmpty(rows: ReadonlyArray<{ id: string }>, href: (id: string) => string, runsHref: string): EmptyPick {
  if (rows[0]) return { title: 'Choose a brief', description: 'A brief is the exact text a run was given when it started: pick a run from the list to read it.', action: { label: 'Open the newest brief', href: href(rows[0].id) } };
  return { title: 'No briefs yet', description: 'Every agent run freezes the text it starts with here: the task, the project, the decisions that bind it and its runbooks.', action: { label: 'See the runs', href: runsHref } };
}
