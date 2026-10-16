// The local data assistant: questions about the app's own program data,
// answered from the same providers the pages read — no AgentCore, no Bedrock,
// in dev:mock and against Aurora alike. See docs/local-answers.md.
//
// routes/agents.ts asks `answerLocally` FIRST for a read-agent invoke; null
// means "not a local question" and the request falls through to the agent path
// unchanged. Matching (./match.ts) is pure and decides before any provider is
// read; this module reads only what the matched intent needs, under the
// caller's authority:
//   - initiatives, work items, contributors: open to the orgiq tenant, as the
//     Initiatives page and /api/graph/* already are;
//   - money (spend, allocation, maintenance floor, envelopes): the budgets read
//     tier only (lib/budget-read-tier.ts) — never widened here; below it the
//     answer says the figures are locked and offers the tier's quick request;
//   - sprints: the whole board for that tier, the caller's own otherwise —
//     the same split GET /api/sprints makes.

import { listProjects, getProject, type ProjectSummary } from '../../providers/projects.js';
import { getProjectWorkItems, getWorkItem, type WorkItem } from '../../providers/work-items.js';
import { listSprints } from '../../providers/sprints.js';
import { listFindings } from '../../providers/org-sweeps.js';
import { getMaintenance30d, type Maintenance30d } from '../../providers/budgets.js';
import { mineViewer } from '../mine.js';
import { canReadBudgets } from '../budget-read-tier.js';
import { clock } from '../../mock/core/index.js';
import { matchIntent, initiativesNamed } from './match.js';
import { INTENTS, type LocalAnswer, type IntentInput, type Contributor } from './intents.js';
import type { AnswerScope } from './scope.js';
import type { Session } from '../session.js';

export type { LocalAnswer } from './intents.js';
export { matchIntent, localAnswersEnabled } from './match.js';
export { parseAnswerScope, parseAnswerStance, scopeContextLine, type AnswerScope, type AnswerStance } from './scope.js';

/** The Initiatives page reads at most this many; a full window makes "every initiative" a floor. */
const INITIATIVES_WINDOW = 200;

export async function answerLocally(input: {
  question: string;
  scope: AnswerScope | null;
  /** `grants` carries a capability grant the tier recognises (orgiq `budgets-reader`). */
  session: Pick<Session, 'sub' | 'tenant' | 'role'> & { grants?: Session['grants'] };
  /** Injected for tests; the request time otherwise. */
  asOf?: Date;
}): Promise<LocalAnswer | null> {
  const { question, scope, session } = input;
  // Cheap pre-check, assuming the question might name an initiative.
  if (!matchIntent(question, scope, true)) return null;

  const initiatives = await listProjects({ limit: INITIATIVES_WINDOW });
  let focusItem: WorkItem | null = null;
  let focus: ProjectSummary[] = [];
  if (scope?.kind === 'initiative') focus = initiatives.filter(p => p.id === scope.id);
  if (scope?.kind === 'work') {
    focusItem = await getWorkItem(scope.id);
    focus = focusItem ? initiatives.filter(p => p.id === focusItem!.projectId) : [];
  }
  // A question naming other initiatives asks about those, whatever page it came from.
  const named = initiativesNamed(question, initiatives);
  if (named.length) { focus = named; if (focusItem && !named.some(p => p.id === focusItem!.projectId)) focusItem = null; }

  const match = matchIntent(question, scope, focus.length > 0);
  if (!match) return null;
  // "What's open on it?" with a scope whose record no longer exists: not answerable here.
  if ((match.intent === 'work') && !focus.length) return null;

  const viewer = { canReadBudgets: await canReadBudgets(session), role: session.role };
  const asOf = input.asOf ?? clock.now();
  const subject = focus.length ? focus : initiatives;
  const intentInput: IntentInput = {
    match, viewer, asOf, initiatives, initiativesCapped: initiatives.length >= INITIATIVES_WINDOW, focus, focusItem,
  };

  if (match.intent === 'budget' && viewer.canReadBudgets) {
    const withAllocation = subject.filter(p => p.allocatedUsd != null);
    const floors = await Promise.all(withAllocation.map(async p => [p.id, await getMaintenance30d(p.id)] as const));
    intentInput.maintenance = new Map<string, Maintenance30d>(floors);
  }
  if (match.intent === 'work' || (match.intent === 'status' && (match.facets.blocked || !(match.facets.critical || match.facets.behind)))) {
    const items = await Promise.all(subject.map(async p => [p.id, await getProjectWorkItems(p.id)] as const));
    intentInput.workItems = new Map(items);
  }
  if (match.intent === 'sprints' || (match.intent === 'status' && (match.facets.behind || !(match.facets.critical || match.facets.blocked)))) {
    const wide = viewer.canReadBudgets;
    const personId = wide ? null : (await mineViewer(session as Session)).personId;
    intentInput.sprints = await listSprints({ personId, mineOnly: !wide, limit: 500 });
    intentInput.sprintsMineOnly = !wide;
  }
  if (match.intent === 'single-threaded') {
    // The Findings route's own floor is a signed-in orgiq session (`requireSession('ViewWork')`), which this path already holds.
    intentInput.findings = await listFindings({ status: 'open', sweep: 'bus_factor', limit: 100 });
  }
  if (match.intent === 'owners' && focus.length) {
    const details = await Promise.all(focus.map(async p => [p.id, (await getProject(p.id))?.contributors ?? []] as const));
    intentInput.contributors = new Map(details.map(([id, cs]) => [id, cs.map((x): Contributor => ({ name: x.name, role: x.role }))]));
  }
  return INTENTS[match.intent](intentInput);
}
