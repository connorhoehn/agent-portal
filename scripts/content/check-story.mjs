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
//   surname-crowd            one surname on more than two people
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
  { socialChannelsFixture, socialChannelMessagesFixture },
] = await Promise.all([
  'mock/initiatives.ts', 'mock/work-items.ts', 'mock/decisions.ts', 'mock/sprints.ts',
  'mock/budgets.ts', 'mock/people.ts', 'providers/identity.ts', 'mock/work-item-comments.ts',
  'mock/social-history.ts', 'mock/notifications.ts', 'mock/org-findings.ts',
  'mock/kb-registry.ts', 'mock/bots.ts', 'providers/work-documents.ts', 'providers/saved-searches.ts',
  'mock/social-channels.ts',
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

let scanned = 0;
function scanText(where, text) {
  scanned += 1;
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

// ── Report ──
if (findings.length === 0) {
  console.log(`check-story: the Work story holds: ${decisions.length} decisions, ${initiatives.rows().length} initiatives, ` +
    `${sprints.rows().filter((x) => x.status === 'active').length} active sprints, ${scanned} display strings, ${bySurname.size} surnames.`);
  process.exit(0);
}
const byCheck = Object.groupBy(findings, (f) => f.check);
for (const [check, list] of Object.entries(byCheck)) {
  console.log(`\n${check} (${list.length})`);
  for (const f of list) console.log(`  ${f.where}: ${f.what}`);
}
console.log(`\ncheck-story: ${findings.length} finding(s).`);
process.exit(1);
