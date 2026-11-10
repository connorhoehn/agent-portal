#!/usr/bin/env node
// scripts/content/check-story.mjs : the Work demo's story, checked.
//
// The Work (orgiq) demo data tells one story about Halyard (docs/demo-script.md).
// A content audit found the ways it drifts apart; each is a check here, run over
// the mock fixtures as dev:mock serves them (the parity suite keeps the seed SQL
// equal to these rows, so checking the fixtures checks both):
//
//   decider-off-initiative   a decision's decider (its `decider` participant, or
//                            who decided it) is not the initiative's owner,
//                            sponsor, an SME or an assignee of its work; an
//                            escalated decision may name an org leader instead,
//                            which is what escalating it means
//   no-sign-in               an initiative owner or a decider has no seeded login
//                            (providers/identity.ts), so the demo cannot act as them
//   sprint-out-of-days       an active sprint whose last day has passed
//   sprint-over-envelope     an active sprint whose planned work costs more than
//                            its envelopes, unless DELIBERATE names it
//   machine-text             a display string carries a raw id or UUID, or says
//                            mock / fixture / wire-capture / OrgIQ / connorhoehn
//   mock-id                  a display string carries an offline fixture id
//                            (`mock-inv-0`, `mock-supervisor-system-prompt`):
//                            the mock's own key showing through to a reader
//   run-steps-repeat         an agent run whose steps share a name (the Steps
//                            table read "route, route"), scanned over the
//                            supervisor runs the trace fixture projects
//   run-title-id             a run title (/iq/runs) carries a bracketed record id
//                            (`[wi-auth-e2-b3]`), from a dispatch prompt or a
//                            seeded run
//   surname-crowd            one surname on more than two people
//   pending-decision-step    a work item's stored next step (or its detail)
//                            says who decides, or names a pending decision the
//                            item waits on: the readers derive that line from
//                            the decision (portal lib/workNextStep.ts), and the
//                            prose goes stale once it is decided
//
//   node scripts/content/check-story.mjs     prints every finding; exit 1 on any
//
// Runs from anywhere: it loads the TypeScript fixtures through middleware's own
// tsx (middleware/node_modules), so CI needs only middleware's `npm ci`.

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MW = resolve(ROOT, 'middleware');

// Over-envelope sprints the story keeps on purpose, each with its reason.
const DELIBERATE = {
  // Inference Platform's allocation is held at null and its sprint planned past
  // its grant: the Budgets page's "over" state needs one real example
  // (mock/budgets.ts, bg-inf-1).
  'spr-inf-s1': 'the over-envelope example the Budgets page shows',
};

// The fixtures read the offline config; never reach for a database or AWS.
Object.assign(process.env, {
  DEV_OFFLINE: 'true', MOCK_AURORA: 'true', MOCK_AGENTCORE: 'true',
  MOCK_GUARDRAILS: 'true', MOCK_CLOUDWATCH: 'true', MOCK_QUEUE: 'true',
});

const require = createRequire(resolve(MW, 'package.json'));
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const load = (rel) => tsImport(pathToFileURL(resolve(MW, 'src', rel)).href, import.meta.url);

const [
  { initiatives }, { workItems }, { decisionRows, decisionParticipantRows }, { sprints },
  { budgetGrants }, { seededPeople }, { seedUserForPerson, listUsers }, { workItemComments },
  { CAST, HISTORY, EXTRA_CHANNELS }, { notificationsFixture }, { orgFindings },
  { kbRegistry }, { bots }, { workspaceDocuments }, { savedSearchesFixture },
  { socialChannelsFixture, socialChannelMessagesFixture }, { traceRows },
  { renderWorkItemPrompt }, { projectRuns, projectRunTitle }, { agentProjectRuns }, { agentJobs }, { allMockRuns },
] = await Promise.all([
  'mock/initiatives.ts', 'mock/work-items.ts', 'mock/decisions.ts', 'mock/sprints.ts',
  'mock/budgets.ts', 'mock/people.ts', 'providers/identity.ts', 'mock/work-item-comments.ts',
  'mock/social-history.ts', 'mock/notifications.ts', 'mock/org-findings.ts',
  'mock/kb-registry.ts', 'mock/bots.ts', 'providers/work-documents.ts', 'providers/saved-searches.ts',
  'mock/social-channels.ts', 'mock/observability.ts',
  'lib/bot-runner.ts', 'lib/pipeline-runs.ts', 'mock/agent-project-runs.ts', 'mock/agent-jobs.ts', 'mock/bots.ts',
].map(load));

const findings = [];
const fail = (check, where, what) => findings.push({ check, where, what });

const people = new Map(seededPeople.map((p) => [p.id, p.name]));
const who = (id) => `${people.get(id) ?? id} (${id})`;
const items = workItems.rows();
const decisions = decisionRows.rows();
const participants = decisionParticipantRows.rows();
const leaders = new Set((await listUsers()).filter((u) => u.personId && u.grants?.orgiq?.includes('org-leader')).map((u) => u.personId));

// ── Deciders on their initiative; owners and deciders can sign in ──
const members = new Map();
for (const ini of initiatives.rows()) {
  members.set(ini.id, new Set([ini.owner, ini.sponsor, ...ini.smes].filter(Boolean)));
  if (!seedUserForPerson(ini.owner)) fail('no-sign-in', ini.name, `owner ${who(ini.owner)} has no seeded login`);
}
for (const wi of items) if (wi.assigneeId) members.get(wi.projectId)?.add(wi.assigneeId);

for (const d of decisions) {
  const deciders = new Set(participants.filter((p) => p.decisionId === d.id && p.role === 'decider').map((p) => p.personId));
  if (d.decidedBy && /^p-\d+$/.test(d.decidedBy)) deciders.add(d.decidedBy);
  for (const id of deciders) {
    if (!seedUserForPerson(id)) fail('no-sign-in', `"${d.topic}"`, `decider ${who(id)} has no seeded login`);
    const escalatedToLeader = d.status === 'escalated' && leaders.has(id);
    if (d.projectId && !members.get(d.projectId)?.has(id) && !escalatedToLeader) {
      fail('decider-off-initiative', `"${d.topic}"`, `decider ${who(id)} is not on ${d.projectId}`);
    }
  }
}

// ── Active sprints: days left, and planned work against the envelopes ──
const today = new Date().toISOString().slice(0, 10);
for (const s of sprints.rows()) {
  if (s.status !== 'active') continue;
  if (s.endsOn && s.endsOn < today) fail('sprint-out-of-days', s.name, `active, but it ended on ${s.endsOn}`);
  const planned = items.filter((w) => w.sprintId === s.id).reduce((n, w) => n + (w.estimatedCostUsd ?? 0), 0);
  const envelope = budgetGrants.rows().filter((g) => g.sprintId === s.id).reduce((n, g) => n + g.allocatedUsd, 0);
  if (planned > envelope + 1e-9 && !DELIBERATE[s.id]) {
    fail('sprint-over-envelope', `${s.name} (${s.orgProjectName ?? s.orgProjectId})`,
      `plans $${planned.toFixed(2)} against $${envelope.toFixed(2)} of envelopes`);
  }
}

// ── Display strings ──
// Raw ids are matched against the ids the data actually uses, so ordinary
// words never trip it.
const USER_IDS = Object.keys(CAST);
const DECISION_IDS = decisions.map((d) => d.id);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RAW_ID = new RegExp(
  String.raw`\b(?:p-\d{3}|wi-[a-z]+-e\d+(?:-[a-z]\d+)?|spr-[a-z0-9]+-s\d+|bg-[a-z0-9]+-\d+|wic-[a-z]+-\d+|` +
  [...USER_IDS, ...DECISION_IDS].map(esc).join('|') + String.raw`)\b`);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const WORDS = [[/\bmock(?:ed|s)?\b/i, 'mock'], [/\bfixtures?\b/i, 'fixture'], [/wire-capture/i, 'wire-capture'],
  [/OrgIQ/, 'OrgIQ'], [/connorhoehn/i, 'connorhoehn']];
const DISPLAY = new Set(['title', 'name', 'summary', 'description', 'body', 'text', 'detail', 'goal', 'topic',
  'resolution', 'label', 'markdown', 'displayName', 'nextStep', 'nextStepDetail', 'blockedReason',
  'pausedReason', 'reason', 'query', 'actionLabel']);

// A fixture's own key: `mock-` and at least one more hyphenated part.
const MOCK_ID = /\bmock-[a-z0-9]+(?:-[a-z0-9]+)*\b/i;

let scanned = 0;
function scanText(where, text) {
  scanned += 1;
  const mockId = text.match(MOCK_ID);
  if (mockId) { fail('mock-id', where, `fixture id "${mockId[0]}" in "${clip(text)}"`); return; }
  const id = text.match(RAW_ID) ?? text.match(UUID);
  if (id) fail('machine-text', where, `raw id "${id[0]}" in "${clip(text)}"`);
  for (const [re, word] of WORDS) if (re.test(text)) fail('machine-text', where, `says "${word}": "${clip(text)}"`);
}
function scanRow(source, row, depth = 0) {
  if (!row || typeof row !== 'object' || depth > 3) return;
  const label = `${source} ${row.id ?? row.key ?? ''}`.trim();
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && DISPLAY.has(k)) scanText(`${label}.${k}`, v);
    else if (Array.isArray(v)) v.forEach((x) => scanRow(`${label}.${k}`, x, depth + 1));
    else if (v && typeof v === 'object') scanRow(`${label}.${k}`, v, depth + 1);
  }
}
const clip = (s) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);

const tables = {
  initiatives: initiatives.rows(), 'work items': items, decisions, sprints: sprints.rows(),
  'work-item comments': workItemComments.rows().filter((c) => !c.isSystem),
  notifications: notificationsFixture.rows().filter((n) => n.tenant === 'orgiq' || n.tenant === 'social'),
  findings: orgFindings.rows(), 'knowledge bases': kbRegistry.rows(), bots: bots.rows(),
  'workspace documents': workspaceDocuments.rows(), 'saved searches': savedSearchesFixture.rows(),
  channels: socialChannelsFixture.rows(), 'channel messages': socialChannelMessagesFixture.rows(),
};
for (const [source, rows] of Object.entries(tables)) for (const row of rows) scanRow(source, row);
for (const [key, where, , , text] of HISTORY) scanText(`chat ${where} ${key}`, text);

// ── Agent runs: the supervisor traces that open a run (pipelines P1) ──
// Their step names are the run's Steps table; one run never repeats a name.
for (const row of traceRows().filter((r) => r.agui_run_id && Array.isArray(r.steps))) {
  const where = `agent run "${clip(row.prompt_snippet ?? row.invocation_id)}"`;
  const names = row.steps.map((st) => st.name);
  for (const n of names) scanText(`${where} step`, n);
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);
  if (repeated.length) fail('run-steps-repeat', where, `steps ${names.join(', ')} repeat ${[...new Set(repeated)].join(', ')}`);
}
// ── Run titles (/iq/runs): no bracketed record id ──
// A dispatched work item's run is titled from its prompt, which carries
// `KEY [wi-…]` on its bookkeeping line; the ledger once showed that line. Every
// work item is rendered as a dispatch would render it, in both the current and
// the earlier prompt order, plus the seeded runs as the projection titles them.
const BRACKETED = /\[[a-z]+-[a-z0-9-]+\]/i;
const legacyOrder = (prompt) => { const [title, preamble, ...rest] = prompt.split('\n'); return [preamble, title, ...rest].join('\n'); };
for (const wi of items) {
  const prompt = renderWorkItemPrompt(wi);
  for (const [order, text] of [['dispatch', prompt], ['earlier dispatch', legacyOrder(prompt)]]) {
    const title = projectRunTitle(text);
    scanned += 1;
    if (BRACKETED.test(title)) fail('run-title-id', `${order} of ${wi.id}`, `run title "${clip(title)}"`);
  }
}
const { runs: seededRuns } = projectRuns({
  agentJobs: agentJobs.rows(), botRuns: allMockRuns(), agentProjectRuns: agentProjectRuns.rows(), assessmentRuns: [],
});
for (const run of seededRuns) {
  scanned += 1;
  if (BRACKETED.test(run.context.title)) fail('run-title-id', run.id, `run title "${clip(run.context.title)}"`);
}

for (const ch of EXTRA_CHANNELS) { scanText(`channel ${ch.slug}.name`, ch.name); scanText(`channel ${ch.slug}.description`, ch.description); }

// ── Surnames ──
const bySurname = new Map();
for (const name of new Set([...seededPeople.map((p) => p.name), ...Object.values(CAST)])) {
  const surname = name.trim().split(/\s+/).at(-1);
  bySurname.set(surname, [...(bySurname.get(surname) ?? []), name]);
}
for (const [surname, names] of bySurname) {
  if (names.length > 2) fail('surname-crowd', surname, `${names.length} people: ${names.join(', ')}`);
}

// ── Stored next steps that wait on a decision ──
// The brief, the voice and the composer derive "the decision comes first" from
// the decision itself (portal lib/workNextStep.ts), so a seeded next step that
// names who decides, or the pending decision, goes stale the moment it is made.
const DECIDER_PROSE = /\bdecid(e|es|ing)\b/i;
const PENDING = new Set(['open', 'escalated']);
let nextSteps = 0;
for (const wi of items) {
  for (const [field, text] of [['nextStep', wi.nextStep], ['nextStepDetail', wi.nextStepDetail]]) {
    if (typeof text !== 'string' || !text.trim()) continue;
    if (field === 'nextStep') nextSteps += 1;
    const waits = decisions.filter((d) => PENDING.has(d.status) && (d.id === wi.blockedByDecisionId || d.workItemId === wi.id));
    const named = waits.find((d) => text.includes(d.topic));
    if (named) fail('pending-decision-step', wi.id, `stored ${field} names the pending decision "${named.topic}": "${text}"`);
    else if (DECIDER_PROSE.test(text)) fail('pending-decision-step', wi.id, `stored ${field} says who decides: "${text}"`);
  }
}

// ── Report ──
if (findings.length === 0) {
  console.log(`check-story: the Work story holds: ${decisions.length} decisions, ${initiatives.rows().length} initiatives, ` +
    `${sprints.rows().filter((x) => x.status === 'active').length} active sprints, ${scanned} display strings, ${bySurname.size} surnames, ${nextSteps} next steps.`);
  process.exit(0);
}
const byCheck = Object.groupBy(findings, (f) => f.check);
for (const [check, list] of Object.entries(byCheck)) {
  console.log(`\n${check} (${list.length})`);
  for (const f of list) console.log(`  ${f.where}: ${f.what}`);
}
console.log(`\ncheck-story: ${findings.length} finding(s).`);
process.exit(1);
