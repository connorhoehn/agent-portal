// Sample decks for the default mock world: four initiative decks (orgiq) and
// one team readout (assessment), so a peer opening an initiative or a team
// finds a finished, designed deck beside the Generate button.
//
// Why these may be seeded when the facts decks are not: the deck fixtures seed
// empty because a stored spec is a second copy of numbers that could disagree
// with the rows it was read from. These specs are not stored copies. Each one
// is BUILT when the fixture's rows are read (reset, scenario switch, boot),
// and every name, count, date and chart value in it is read from the fixture
// rows at that moment: work items, sprints, decisions, people, the agent job
// queue, the org-sweep findings and the assessment scores. Only the prose
// between the numbers is written here. __tests__/sample-decks.test.ts checks
// the charts against the reports and providers that serve the same rows, and
// that every deck validates and lays out with zero findings.
//
// The empty scenario stays empty. The samples are not written to the opt-in
// durable initiative-deck file (initiative-deck-durability.ts): they are
// rebuilt from the seed on every boot, so an edit to a sample deck lasts for
// the session only.

import type { DeckChart, DeckSlide, DeckSource, DeckSpec, DeckText } from '@connorhoehn/realtime-modules/deck';
import type { DeckStyle } from '@connorhoehn/realtime-modules/deck/layout';
import { withDeckStyle, type DeckHostTenant } from '../lib/deck-shared/themes.js';
import { clock, DAY_MS, HOUR_MS } from './core/index.js';
import { utcDayStartMs } from './core/clock.js';
import { workItems } from './work-items.js';
import { sprints, type MockSprint } from './sprints.js';
import { decisionRows, type DecisionRow } from './decisions.js';
import { initiatives } from './initiatives.js';
import { mockPeople } from './people.js';
import { mockJobs } from './agent-jobs.js';
import { mockFindings } from './org-findings.js';
import * as A from './assessment.js';

// ─── Ids ──────────────────────────────────────────────────────────────────────

const uuid = (n: number) => `5a301e00-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const SAMPLE_INITIATIVE_DECKS = [
  { key: 'auth-steering', projectId: 'p-auth-migration', n: 1 },
  { key: 'observability-review', projectId: 'p-observability', n: 2 },
  { key: 'soc2-readiness', projectId: 'p-soc2', n: 3 },
  { key: 'rag-retrospective', projectId: 'p-rag-search', n: 4 },
] as const;
export const SAMPLE_ASSESSMENT_DECKS = [{ key: 'northstar-readout', teamId: 'TEAM-001', n: 5 }] as const;

export const sampleDeckId = (prefix: 'idk' | 'deck', n: number) => `${prefix}-${uuid(n)}`;
export const sampleRevisionId = (prefix: 'irev' | 'rev', n: number) => `${prefix}-${uuid(n)}`;
/** True for a deck id the seed builds (never persisted by the durable store). */
export const isSampleDeckId = (id: string): boolean => /^(idk|deck)-5a301e00-0000-4000-8000-\d{12}$/.test(id);

// ─── Reading the rows ─────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "19 Nov" */
const short = (iso: string | null | undefined): string => {
  if (!iso) return 'not set';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
};
/** "19 November 2026" */
const long = (iso: string): string => { const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const personName = (id: string): string => mockPeople.find((p) => p.id === id)?.name ?? id;
const personTitle = (id: string): string => mockPeople.find((p) => p.id === id)?.title ?? '';

function initiative(id: string) {
  const i = initiatives.rows().find((x) => x.id === id);
  if (!i) throw new Error(`sample decks: initiative ${id} is not in the seed`);
  return i;
}
const itemsOf = (projectId: string) => workItems.rows().filter((w) => w.projectId === projectId);
function item(projectId: string, key: string) {
  const w = itemsOf(projectId).find((x) => x.key === key);
  if (!w) throw new Error(`sample decks: ${key} is not on ${projectId}'s board`);
  return w;
}
const sprintsOf = (projectId: string): MockSprint[] => sprints.rows().filter((s) => s.orgProjectId === projectId).sort((a, b) => (a.startsOn ?? '').localeCompare(b.startsOn ?? ''));
function decision(id: string): DecisionRow {
  const d = decisionRows.rows().find((x) => x.id === id);
  if (!d) throw new Error(`sample decks: decision ${id} is not in the seed`);
  return d;
}
const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', in_review: 'In review', done: 'Done', cancelled: 'Cancelled' };
const STATUSES = ['open', 'in_progress', 'in_review', 'done'] as const;
/** Work items (epics left out) counted by status, in board order. */
export function workStatusCounts(projectId: string): Record<(typeof STATUSES)[number], number> {
  const out = { open: 0, in_progress: 0, in_review: 0, done: 0 };
  for (const w of itemsOf(projectId)) if (w.type !== 'epic' && w.status in out) out[w.status as keyof typeof out] += 1;
  return out;
}
const workChart = (projectId: string, kind: DeckChart['kind'] = 'bar'): DeckChart => {
  const c = workStatusCounts(projectId);
  return { kind, labels: STATUSES.map((s) => STATUS_LABEL[s]!), series: [{ name: 'Stories and bugs', values: STATUSES.map((s) => c[s]) }] };
};
const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** The jobs-by-status report's numbers, from the same rows queueStats() counts. */
export function jobsByStatusChart(kind: DeckChart['kind'] = 'bar'): DeckChart {
  const counts = new Map<string, number>();
  for (const j of mockJobs) counts.set(j.status, (counts.get(j.status) ?? 0) + 1);
  const order = ['queued', 'claimed', 'running', 'awaiting_review', 'done', 'failed', 'cancelled'];
  const keys = order.filter((k) => (counts.get(k) ?? 0) > 0);
  return { kind, labels: keys.map(label), series: [{ name: 'Jobs', values: keys.map((k) => counts.get(k)!) }] };
}
/** The findings-by-severity report's numbers, from the same rows findingStats() counts. */
export function findingsBySeverityChart(kind: DeckChart['kind'] = 'bar'): DeckChart {
  const counts = new Map<string, number>();
  for (const f of mockFindings) if (f.status === 'open') counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const order = ['critical', 'warning', 'info'];
  const keys = [...counts.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return { kind, labels: keys.map(label), series: [{ name: 'Open findings', values: keys.map((k) => counts.get(k)!) }] };
}
const sum = (c: DeckChart) => c.series[0]!.values.reduce((a, b) => a + b, 0);
const valueOf = (c: DeckChart, l: string) => c.series[0]!.values[c.labels.indexOf(l)] ?? 0;

// ─── Sources ──────────────────────────────────────────────────────────────────

const record = (projectId: string, anchor?: string): DeckSource => ({ documentId: `initiative:${projectId}`, ...(anchor ? { anchor } : {}), title: 'The initiative record' });
const decisionSrc = (d: DecisionRow): DeckSource => ({ documentId: `decision:${d.id}`, title: `Decision: ${d.topic}`.slice(0, 200) });
const reportSrc = (id: 'jobs-by-status' | 'findings-by-severity'): DeckSource =>
  id === 'jobs-by-status'
    ? { documentId: 'report:jobs-by-status', anchor: 'now', title: 'Work queue by status (now)' }
    : { documentId: 'report:findings-by-severity', anchor: 'open now', title: 'Findings by severity (open now)' };
const readNote = (report: string, now: string) => `Chart data read from the report "${report}" on ${long(now)}.`;

type SlideIn = Omit<DeckSlide, 'sources'> & { sources?: DeckSource[] };
function spec(tenant: DeckHostTenant, style: DeckStyle, title: string, subtitle: string, fallback: DeckSource, slides: SlideIn[]): DeckSpec {
  return {
    title, subtitle, theme: withDeckStyle({ ref: tenant }, style, tenant),
    slides: slides.map((s) => ({ ...s, sources: s.sources ?? [fallback] })),
  };
}
const t = (...runs: Array<string | [string, NonNullable<Exclude<DeckText, string>[number]['emphasis']>]>): DeckText =>
  runs.map((r) => (typeof r === 'string' ? { text: r } : { text: r[0], emphasis: r[1] }));

// ─── Orgiq: Auth Migration, a steering update (corporate) ────────────────────

function authSteering(now: string): DeckSpec {
  const pid = 'p-auth-migration';
  const ini = initiative(pid);
  const owner = personName(ini.owner), sponsor = personName(ini.sponsor);
  const [s9, s10] = sprintsOf(pid);
  const c = workStatusCounts(pid);
  const total = c.open + c.in_progress + c.in_review + c.done;
  const cutover = decision('d-cognito-cutover');
  const sunset = decision('d-legacy-auth');
  const pkce = item(pid, 'ORG-AUTH-2'), jwks = item(pid, 'ORG-AUTH-3'), inventory = item(pid, 'ORG-AUTH-7');
  const loop = item(pid, 'ORG-AUTH-5'), runbook = item(pid, 'ORG-AUTH-8'), cookie = item(pid, 'ORG-AUTH-4'), logout = item(pid, 'ORG-AUTH-9');
  const s10Items = itemsOf(pid).filter((w) => w.sprintId === s10!.id);
  const jobs = jobsByStatusChart('bar');
  const rec = record(pid);
  const pts = (w: { storyPoints: number | null }) => `${w.storyPoints ?? 0} points`;
  return spec('orgiq', 'corporate', `${ini.name}: steering update`, `For the steering group, ${long(now)}`, rec, [
    {
      id: 'title', layout: 'title', title: t(`${ini.name}: `, ['one login path', 'accent']), eyebrow: `Steering update · ${short(now)}`,
      bullets: [`Owner ${owner} · sponsor ${sponsor}`],
      notes: `Opening. ${ini.name} moves every login onto Cognito with the BFF holding tokens, then retires the SAML shim. This update covers ${s9!.name} and the sprint now running.`,
    },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['Where the work stands', `What ${s9!.name.split(' — ')[0]} delivered`, `${s10!.name.split(' — ')[0]} in flight`, 'The cutover order', 'What we need from you'], current: 0 }, notes: 'Five parts, about fifteen minutes. The cutover order is the one decision on the table.' },
    {
      id: 'standing', layout: 'kpi', title: 'Where the work stands',
      figures: [
        { value: `${c.done} of ${total}`, label: 'Stories and bugs done', icon: 'circle-check' },
        { value: String(c.in_review), label: 'Waiting in review', icon: 'eye' },
        { value: String(c.open), label: 'Not started yet', icon: 'list-todo' },
      ],
      chart: workChart(pid),
      sources: [rec],
      notes: `Counted from the initiative board on ${long(now)}; epics are left out so each item is counted once. ${c.in_progress} items are in progress.`,
    },
    { id: 'section-s9', layout: 'section', title: s9!.name, eyebrow: `Done · ${short(s9!.startsOn)} to ${short(s9!.endsOn)}`, sources: [rec], notes: `Sprint goal: ${s9!.goal}` },
    {
      id: 'delivered', layout: 'cards', title: t('What Sprint 9 ', ['delivered', 'underline']),
      items: [
        { title: 'Code and PKCE flow', text: `The BFF runs the authorization-code flow with PKCE. ${pkce.assigneeName}, ${pts(pkce)}.`, icon: 'key-round' },
        { title: 'Key rotation that holds', text: `JWKS checks survive a signing-key roll. ${jwks.assigneeName}, ${pts(jwks)}.`, icon: 'shield-check' },
        { title: 'Every shim consumer found', text: `The list of services still on the SAML shim. ${inventory.assigneeName}, ${pts(inventory)}.`, icon: 'list-checks' },
      ],
      sources: [rec],
      notes: `All three stories closed inside the sprint, ${pkce.storyPoints! + jwks.storyPoints! + inventory.storyPoints!} points in all. The inventory is what makes a tenant-by-tenant cutover possible.`,
    },
    {
      id: 'sprint10', layout: 'table', title: `${s10!.name.split(' — ')[0]}: ${s10!.name.split(' — ')[1]}`,
      table: {
        header: ['Item', 'Work', 'Owner', 'Status'],
        rows: s10Items.map((w) => [w.key ?? '', SHORT_AUTH[w.key ?? ''] ?? w.title.slice(0, 40), w.assigneeName ?? 'Unassigned', STATUS_LABEL[w.status] ?? w.status]),
      },
      sources: [rec],
      notes: `Sprint goal: ${s10!.goal} It ends ${long(s10!.endsOn!)}. The refresh loop (${loop.key}) is the item to watch: it is critical and in progress.`,
    },
    {
      id: 'timeline', layout: 'timeline', title: 'Two sprints to the cutover',
      timeline: [
        { date: short(s9!.startsOn), label: `${s9!.name.split(' — ')[0]} starts`, detail: 'OIDC core: code flow and key rotation' },
        { date: short(s9!.endsOn), label: `${s9!.name.split(' — ')[0]} closes`, detail: 'Three stories done, the shim inventory in hand' },
        { date: short(s10!.startsOn), label: `${s10!.name.split(' — ')[0]} starts`, detail: 'Session hygiene and the cutover runbook' },
        { date: short(cutover.escalatedAt), label: 'Cutover order escalated', detail: 'Sent to an org leader as a release call' },
        { date: short(s10!.endsOn), label: `${s10!.name.split(' — ')[0]} ends`, detail: 'Runbook ready for the first tenant' },
      ],
      decoration: { graphic: 'timeline', placement: 'corner' },
      sources: [rec, decisionSrc(cutover)],
      notes: 'Dates come from the sprint rows and the decision record.',
    },
    {
      id: 'cutover', layout: 'comparison', title: 'The cutover order',
      comparison: {
        left: { title: 'Smallest tenants first', icon: 'shield', points: ['Keeps the blast radius low', 'The team learns the runbook on quiet tenants', 'Leaves the two custom-mapping tenants for last'] },
        right: { title: 'Riskiest tenants first', icon: 'zap', points: ['Moves the two custom SAML mappings while the shim is warm', 'Rollback is still a route flip', 'A failure is loud and customers see it'] },
        verdict: `Escalated ${short(cutover.escalatedAt)}: the order decides who is warned and when.`,
      },
      sources: [decisionSrc(cutover)],
      notes: `From the decision record "${cutover.topic}". Twelve customer tenants are still on the shim, and each moves with the single-tenant runbook (${runbook.key}).`,
    },
    {
      id: 'agents', layout: 'chart', title: 'The agent queue behind the work',
      chart: jobs, sources: [reportSrc('jobs-by-status')],
      notes: `${readNote('Agent jobs by status', now)} ${valueOf(jobs, 'Done')} of ${sum(jobs)} jobs finished and ${valueOf(jobs, 'Failed')} failed. The queue is org-wide, not this initiative's alone.`,
    },
    {
      id: 'people', layout: 'people', title: 'Who is carrying it',
      people: [
        { name: owner, role: 'Owner', detail: personTitle(ini.owner) },
        { name: sponsor, role: 'Sponsor', detail: personTitle(ini.sponsor) },
        ...ini.smes.slice(0, 3).map((id) => ({ name: personName(id), role: 'Subject expert', detail: personTitle(id) })),
      ],
      sources: [rec],
      notes: `${personName(s10!.stewardPersonId ?? '')} stewards both sprints.`,
    },
    {
      id: 'closing', layout: 'closing', title: 'What we need from steering',
      closing: {
        line: `Settle the cutover order before ${short(s10!.endsOn)}.`,
        nextSteps: ['Choose smallest-first or riskiest-first', `Review the cutover runbook (${runbook.key})`, `Hear back on the refresh-loop fix (${loop.key})`],
        contact: `${owner}, ${ini.name} owner`,
      },
      sources: [rec, decisionSrc(cutover), decisionSrc(sunset)],
      notes: `The plan itself was settled in "${sunset.topic}" (${short(sunset.decidedAt)}). Still open besides the order: ${cookie.key} in review and ${logout.key}, a logout bug.`,
    },
  ]);
}
const SHORT_AUTH: Record<string, string> = {
  'ORG-AUTH-4': 'Session cookie hardening', 'ORG-AUTH-5': 'Refresh loop on a revoked grant',
  'ORG-AUTH-8': 'Cutover runbook with rollback', 'ORG-AUTH-9': 'Logout leaves the shim cookie',
};

// ─── Orgiq: Observability Platform, a review (editorial) ─────────────────────

function observabilityReview(now: string): DeckSpec {
  const pid = 'p-observability';
  const ini = initiative(pid);
  const owner = personName(ini.owner), sponsor = personName(ini.sponsor);
  const [s9, s10, s11] = sprintsOf(pid);
  const otel = decision('d-otel'), vendor = decision('d-otel-vendor'), depmap = decision('d-aurora');
  const fleet = item(pid, 'ORG-OBS-2'), sampling = item(pid, 'ORG-OBS-3'), spans = item(pid, 'ORG-OBS-4'), burn = item(pid, 'ORG-OBS-9');
  const oom = item(pid, 'ORG-OBS-6'), dupes = item(pid, 'ORG-OBS-11');
  const epics = itemsOf(pid).filter((w) => w.type === 'epic');
  const byEpic: DeckChart = {
    kind: 'stacked-bar', labels: epics.map((e) => EPIC_SHORT[e.key ?? ''] ?? e.title.slice(0, 24)),
    series: [...STATUSES].reverse().map((s) => ({ name: STATUS_LABEL[s]!, values: epics.map((e) => itemsOf(pid).filter((w) => w.parentId === e.id && w.status === s).length) })),
  };
  const c = workStatusCounts(pid);
  const jobs = jobsByStatusChart('pie');
  const rec = record(pid);
  return spec('orgiq', 'editorial', `${ini.name}: three sprints in`, `A review for ${sponsor} and the platform leads`, rec, [
    {
      id: 'title', layout: 'title', title: t('Fewer alerts, ', ['better ones', 'underline']), eyebrow: `${ini.name} · review to ${short(now)}`,
      bullets: [`Owner ${owner} · sponsor ${sponsor}`],
      notes: `The initiative's summary: ${ini.summary.replace(/\n/g, ' ')}`,
    },
    {
      id: 'headline', layout: 'big-number', title: 'The fleet holds',
      figures: [{ value: '2x', label: 'peak ingest the fleet absorbs', context: `${s9!.name} goal, met ${short(s9!.endsOn)}`, icon: 'gauge' }],
      bullets: [`Collector fleet rolled out by ${fleet.assigneeName}`, `Errors and p99 latency always kept by tail sampling`],
      sources: [rec],
      notes: `The figure is the sprint goal itself: "${s9!.goal}" The sprint closed as done.`,
    },
    {
      id: 'otel', layout: 'big-quote', title: 'The decision underneath',
      quote: { text: otel.resolution ?? otel.topic, by: `Decision record, ${long(otel.decidedAt!)}` },
      sources: [decisionSrc(otel)],
      notes: 'Before this, services traced with three different libraries and no trace crossed a service boundary intact.',
    },
    {
      id: 'sprints', layout: 'timeline', title: 'Three sprints',
      timeline: [s9!, s10!, s11!].map((s) => ({ date: short(s.startsOn), label: s.name.split(' — ')[1]!.slice(0, 40), detail: (s.goal ?? '').slice(0, 80) })),
      sources: [rec],
      notes: `${s9!.name.split(' — ')[0]} and ${s10!.name.split(' — ')[0]} are done; ${s11!.name.split(' — ')[0]} runs to ${long(s11!.endsOn!)}, stewarded by ${s11!.stewardName}.`,
    },
    {
      id: 'pipeline', layout: 'process', title: 'From a span to a page',
      items: [
        { title: 'Collect', text: `Agent and gateway collectors on every host. ${STATUS_LABEL[fleet.status]}.`, icon: 'server' },
        { title: 'Sample', text: `Keep every error and every slow trace. ${STATUS_LABEL[sampling.status]}.`, icon: 'filter' },
        { title: 'Measure', text: `Span metrics feed the RED dashboards. ${STATUS_LABEL[spans.status]}.`, icon: 'chart-line' },
        { title: 'Alert', text: `Page on error-budget burn, not raw errors. ${STATUS_LABEL[burn.status]}.`, icon: 'bell' },
      ],
      sources: [rec],
      notes: `Each step is a story on the board: ${fleet.key}, ${sampling.key}, ${spans.key} and ${burn.key}. The status after each line is the board's.`,
    },
    {
      id: 'epics', layout: 'kpi', title: 'Progress by epic',
      figures: [
        { value: String(c.done), label: 'Stories and bugs done', icon: 'circle-check' },
        { value: String(c.in_progress + c.in_review), label: 'In progress or review', icon: 'activity' },
        { value: String(c.open), label: 'Still open', icon: 'list-todo' },
      ],
      chart: byEpic,
      sources: [rec],
      notes: `Children of each epic, counted from the board on ${long(now)}. Cost-aware telemetry has not started: all of its stories are open.`,
    },
    {
      id: 'vendor', layout: 'comparison', title: 'Our collectors or a vendor\'s agents',
      comparison: {
        left: { title: 'Vendor APM agents', icon: 'credit-card', points: ['Priced per host', 'About three times the cost of our own collectors', 'Each agent ships its own sampling'] },
        right: { title: 'Self-hosted collectors', icon: 'server', points: ['Agent and gateway topology we run', 'One sampling policy for every service', 'OTLP to the backend we already have'] },
        verdict: `Decided ${short(vendor.decidedAt)}: self-hosted OpenTelemetry collectors.`,
      },
      sources: [decisionSrc(vendor)],
      notes: `From "${vendor.topic}". A later decision, "${depmap.topic}", keeps the dependency map in Postgres.`,
    },
    {
      id: 'queue', layout: 'chart', title: 'The agent queue has an error budget too',
      chart: jobs, sources: [reportSrc('jobs-by-status')],
      notes: `${readNote('Agent jobs by status', now)} ${valueOf(jobs, 'Failed')} of ${sum(jobs)} jobs failed, about ${Math.round((100 * valueOf(jobs, 'Failed')) / Math.max(1, sum(jobs)))} percent. Worth a burn-rate alert of its own once the dashboards land.`,
    },
    {
      id: 'risks', layout: 'bullets', title: 'Two bugs to watch',
      bullets: [
        t([`${oom.key}: `, 'bold'], `collectors run out of memory under burst ingest (${STATUS_LABEL[oom.status]?.toLowerCase()}, ${oom.assigneeName})`),
        t([`${dupes.key}: `, 'bold'], `duplicate alerts during a dependency outage (${STATUS_LABEL[dupes.status]?.toLowerCase()}, ${dupes.assigneeName})`),
      ],
      sources: [rec, decisionSrc(depmap)],
      notes: `${oom.key} is critical. ${dupes.key} depends on the dependency map settled in "${depmap.topic}".`,
    },
    {
      id: 'closing', layout: 'closing', title: `What ${s11!.name.split(' — ')[0]} must land`,
      closing: { line: 'RED dashboards, and two services off StatsD.', nextSteps: [`Finish the span-metrics connector (${spans.key})`, `Ship burn-rate alerts out of review (${burn.key})`, `Fix the collector memory bug (${oom.key})`], contact: `${owner}, ${ini.name} owner` },
      sources: [rec, rec],
      notes: `The closing line is ${s11!.name.split(' — ')[0]}'s goal as recorded: "${s11!.goal}"`,
    },
  ]);
}
const EPIC_SHORT: Record<string, string> = { 'ORG-OBS-1': 'OpenTelemetry', 'ORG-OBS-7': 'SLOs and budgets', 'ORG-OBS-12': 'Cost-aware telemetry' };

// ─── Orgiq: SOC2 Compliance, a readiness check (minimal) ─────────────────────

function soc2Readiness(now: string): DeckSpec {
  const pid = 'p-soc2';
  const ini = initiative(pid);
  const owner = personName(ini.owner), sponsor = personName(ini.sponsor);
  const [s9] = sprintsOf(pid);
  const map = item(pid, 'ORG-SOC2-2'), collectors = item(pid, 'ORG-SOC2-3'), reviews = item(pid, 'ORG-SOC2-4');
  const findings = findingsBySeverityChart('bar');
  const open = mockFindings.filter((f) => f.status === 'open');
  const daysLeft = Math.max(0, Math.round((Date.parse(`${s9!.endsOn}T00:00:00Z`) - utcDayStartMs()) / DAY_MS));
  const c = workStatusCounts(pid);
  const rec = record(pid);
  const SWEEP: Record<string, string> = { bus_factor: 'One person holds the knowledge', orphan_decisions: 'A decision with no owner', stale_docs: 'A document past its review date', 'lab-signal': 'A pattern across Computer Lab runs' };
  return spec('orgiq', 'minimal', `${ini.name}: readiness check`, `Type II readiness, for ${sponsor}`, rec, [
    { id: 'title', layout: 'title', title: `${ini.name}: readiness check`, eyebrow: `Readiness · ${short(now)}`, bullets: [`Owner ${owner} · sponsor ${sponsor}`], notes: `The initiative's aim: ${ini.summary}` },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['Where readiness stands', 'How evidence is collected', 'What the sweeps flag', 'The one open risk', 'Who owns what'] }, notes: 'A short check, ten minutes. The open risk is the part to stay on.' },
    {
      id: 'figures', layout: 'key-figures', title: 'Where readiness stands',
      figures: [
        { value: `${c.done} of ${c.open + c.in_progress + c.in_review + c.done}`, label: 'Stories and bugs done', icon: 'circle-check' },
        { value: String(sum(findings)), label: 'Open findings from the org sweeps', icon: 'shield-alert' },
        { value: `${daysLeft} days`, label: `Left in ${s9!.name.split(' — ')[0]}`, icon: 'calendar' },
      ],
      sources: [rec, reportSrc('findings-by-severity'), rec],
      notes: `Board and sprint read on ${long(now)}; the findings count is the org-wide sweep report.`,
    },
    {
      id: 'evidence', layout: 'process', title: 'How evidence gets to the auditor',
      items: [
        { title: 'Map each control', text: `Every control has an owner in the register. ${STATUS_LABEL[map.status]}, ${map.assigneeName}.`, icon: 'clipboard-list' },
        { title: 'Collect automatically', text: `Collectors pull change and access evidence. ${STATUS_LABEL[collectors.status]}, ${collectors.assigneeName}.`, icon: 'workflow' },
        { title: 'Review access', text: `Quarterly reviews of every account. ${STATUS_LABEL[reviews.status]}: two service accounts are stale.`, icon: 'user-check' },
      ],
      sources: [rec],
      notes: `${map.key}, ${collectors.key} and ${reviews.key} on the board. ${s9!.name}'s goal: ${s9!.goal}`,
    },
    {
      id: 'sweeps', layout: 'chart', title: 'Open findings by severity',
      chart: findings, sources: [reportSrc('findings-by-severity')],
      notes: `${readNote('Open findings by severity', now)} The sweeps are org-wide; an auditor will ask how each is closed.`,
    },
    {
      id: 'findings', layout: 'table', title: 'What the sweeps flag',
      table: { header: ['Sweep', 'What it means', 'Severity'], rows: open.slice(0, 6).map((f) => [label(f.sweep).slice(0, 40), (SWEEP[f.sweep] ?? f.title).slice(0, 40), label(f.severity)]) },
      sources: [reportSrc('findings-by-severity')],
      notes: open.map((f) => f.title).join('; ').slice(0, 1900),
    },
    {
      id: 'split', layout: 'two-column', title: 'Done, and still to do',
      columns: [
        itemsOf(pid).filter((w) => w.type !== 'epic' && w.status === 'done').map((w) => `Done: ${SHORT_SOC2[w.key ?? ''] ?? w.title}`),
        itemsOf(pid).filter((w) => w.type !== 'epic' && w.status !== 'done').map((w) => `${STATUS_LABEL[w.status]}: ${SHORT_SOC2[w.key ?? ''] ?? w.title}`),
      ],
      sources: [rec],
      notes: 'Each line is a story or bug on the board, with its status first.',
    },
    {
      id: 'risk', layout: 'big-number', title: 'The one open risk',
      figures: [{ value: '2', label: 'service accounts with stale access reviews', context: `${reviews.key}, ${reviews.priority} priority`, icon: 'triangle-alert' }],
      bullets: ['A stale review is a control failure in a Type II window', `${reviews.assigneeName} owns the fix`],
      sources: [rec],
      notes: `The bug's title on the board: "${reviews.title}".`,
    },
    {
      id: 'owners', layout: 'people', title: 'Who owns what',
      people: [
        { name: owner, role: 'Owner', detail: personTitle(ini.owner) },
        { name: sponsor, role: 'Sponsor', detail: personTitle(ini.sponsor) },
        ...ini.smes.slice(0, 2).map((id) => ({ name: personName(id), role: 'Subject expert', detail: personTitle(id) })),
      ],
      notes: `${s9!.stewardName} stewards ${s9!.name}.`,
    },
    {
      id: 'closing', layout: 'closing', title: 'Before the sprint ends',
      closing: { line: `Close the access reviews by ${short(s9!.endsOn)}.`, nextSteps: [`Refresh the two stale reviews (${reviews.key})`, `Finish the evidence collectors (${collectors.key})`, 'Give each open sweep finding an owner'], contact: `${owner}, ${ini.name} owner` },
      sources: [rec],
      notes: `${personName(ini.smes[0] ?? '')} and ${personName(ini.smes[1] ?? '')} are the initiative's subject experts.`,
    },
  ]);
}
const SHORT_SOC2: Record<string, string> = { 'ORG-SOC2-2': 'control-to-owner mapping', 'ORG-SOC2-3': 'evidence collectors', 'ORG-SOC2-4': 'stale access reviews' };

// ─── Orgiq: RAG Knowledge Search, a retrospective (playful) ──────────────────

function ragRetrospective(now: string): DeckSpec {
  const pid = 'p-rag-search';
  const ini = initiative(pid);
  const owner = personName(ini.owner), sponsor = personName(ini.sponsor);
  const hybrid = item(pid, 'ORG-RAG-2'), cite = item(pid, 'ORG-RAG-3'), evals = item(pid, 'ORG-RAG-4'), ga = item(pid, 'ORG-RAG-1');
  const vdb = decision('d-vectordb');
  const stories = itemsOf(pid).filter((w) => w.type !== 'epic');
  const done = stories.filter((w) => w.status === 'done');
  const lastDone = done.map((w) => w.completedAt ?? w.updatedAt).sort().at(-1)!;
  const findings = findingsBySeverityChart('pie');
  const points = done.reduce((a, w) => a + (w.storyPoints ?? 0), 0);
  const rec = record(pid);
  return spec('orgiq', 'playful', `${ini.name}: what we shipped`, `A retrospective with ${sponsor}`, rec, [
    { id: 'title', layout: 'title', title: t(`${ini.name}: `, ['shipped', 'highlight']), eyebrow: 'Retrospective', bullets: [`Owner ${owner} · sponsor ${sponsor}`], notes: `The initiative is marked ${ini.status}. Its summary: ${ini.summary}` },
    { id: 'agenda', layout: 'agenda', title: 'What we will cover', agenda: { items: ['What we built', 'The big decision', 'Who built it', 'What still needs care'] }, notes: 'Short and celebratory, with one honest slide at the end.' },
    {
      id: 'result', layout: 'big-number', title: t('All of it, ', ['done', 'bold']),
      figures: [{ value: `${done.length} of ${stories.length}`, label: 'stories done in GA hardening', context: `${points} points, the last closed ${short(lastDone)}`, icon: 'trophy' }],
      bullets: [`The GA hardening epic is ${STATUS_LABEL[ga.status]?.toLowerCase()}`, 'Search is in maintenance now'],
      sources: [rec],
      notes: 'Counted from the board; the epic itself is left out of the count.',
    },
    {
      id: 'built', layout: 'cards', title: 'What we built',
      items: [
        { title: 'Hybrid retrieval', text: `Dense and keyword search, fused into one ranking. ${hybrid.assigneeName}.`, icon: 'search' },
        { title: 'Grounded citations', text: `Every answer points at the span it came from. ${cite.assigneeName}.`, icon: 'quote' },
        { title: 'An eval harness', text: `A labelled query set that scores each change. ${evals.assigneeName}.`, icon: 'target' },
      ],
      sources: [rec],
      notes: `${hybrid.key}, ${cite.key} and ${evals.key}: ${hybrid.storyPoints}, ${cite.storyPoints} and ${evals.storyPoints} points.`,
    },
    {
      id: 'answer', layout: 'process', title: 'How a question gets answered',
      items: [
        { title: 'Retrieve', text: 'Dense and keyword search run side by side', icon: 'search' },
        { title: 'Rank', text: 'Fusion ranking merges the two lists into one', icon: 'layers' },
        { title: 'Cite', text: 'The answer names the passage behind each claim', icon: 'link' },
        { title: 'Score', text: 'The labelled query set catches a worse ranking', icon: 'gauge' },
      ],
      notes: `The four steps are the three stories on the board, in the order a question meets them: ${hybrid.key} covers retrieve and rank.`,
    },
    {
      id: 'vectordb', layout: 'big-quote', title: 'The big decision',
      quote: { text: vdb.resolution ?? vdb.topic, by: `${vdb.topic}, ${long(vdb.decidedAt!)}` },
      sources: [decisionSrc(vdb)],
      notes: 'Retrieval needs about two million embeddings filtered by team and document type. A separate vector database would have been one more system to run.',
    },
    {
      id: 'journey', layout: 'timeline', title: 'How we got here',
      timeline: [
        { date: short(ini.createdAt), label: 'Initiative opened', detail: 'Org search that cites its sources' },
        { date: short(vdb.decidedAt), label: 'Vector store chosen', detail: 'pgvector inside Aurora' },
        { date: short(hybrid.completedAt ?? hybrid.updatedAt), label: 'Hybrid retrieval done' },
        { date: short(lastDone), label: 'GA hardening complete', detail: 'In maintenance from here' },
      ],
      decoration: { graphic: 'rocket', placement: 'title' },
      sources: [rec, decisionSrc(vdb)],
      notes: 'Dates from the initiative, the decision record and the work items.',
    },
    {
      id: 'team', layout: 'people', title: 'Who built it',
      people: [
        { name: owner, role: 'Owner', detail: personTitle(ini.owner) },
        { name: sponsor, role: 'Sponsor', detail: personTitle(ini.sponsor) },
        ...ini.smes.map((id) => ({ name: personName(id), role: 'Subject expert', detail: personTitle(id) })),
      ],
      sources: [rec],
      notes: `${personName(ini.smes[0] ?? '')} built hybrid retrieval and the eval harness.`,
    },
    {
      id: 'care', layout: 'chart', title: 'What still needs care',
      chart: findings, sources: [reportSrc('findings-by-severity')],
      notes: `${readNote('Open findings by severity', now)} Search is only as good as what it cites: the stale-document sweep is the one to watch.`,
    },
    {
      id: 'closing', layout: 'closing', title: 'Thank you, team',
      closing: { line: 'Search that shows its sources.', nextSteps: ['Keep the eval harness in every change', 'Revisit the vector store above 20 million vectors', 'Clear stale documents the sweeps flag'], contact: `${owner}, ${ini.name} owner` },
      sources: [rec, decisionSrc(vdb)],
      notes: 'The 20 million threshold is written into the vector store decision.',
    },
  ]);
}

// ─── Assessment: Northstar Payments, a readout (bold) ────────────────────────

const DIM_SHORT: Record<string, string> = {
  '1': 'Continuous integration', '2': 'Continuous delivery', '3': 'Automation', '4': 'Source control', '5': 'Automated testing',
  '6': 'Security testing', '7': 'Performance testing', '8': 'Secure SDLC and review', '9': 'Engineering governance', '10': 'Observability',
  '11': 'Environments', '12': 'Release and reliability', '13': 'Platform reuse', '14': 'Automation culture', '15': 'Agile planning',
  '16': 'Design standards', '17': 'Engineering metrics',
};
/** The scorecard's certification counts, from the scores the provider reads. */
export function teamCertification(teamId: string) {
  const dims = Object.values(A.scoresFor(teamId) ?? {});
  const target = A.configuration().target_level;
  const applicable = dims.filter((d) => !d.is_na);
  const assessed = applicable.filter((d) => d.current_level !== null);
  return {
    target,
    applicable: applicable.length, assessed: assessed.length,
    atOrAbove: assessed.filter((d) => d.current_level! >= target).length,
    below: assessed.filter((d) => d.current_level! < target).length,
    claimsOpen: assessed.filter((d) => d.self_claimed_level !== null && d.self_claimed_level > d.current_level!).length,
    highest: Math.max(0, ...assessed.map((d) => d.current_level!)),
    dims: assessed,
  };
}

function northstarReadout(now: string): DeckSpec {
  const teamId = 'TEAM-001';
  const team = A.teams().find((x) => x.id === teamId);
  if (!team) throw new Error(`sample decks: team ${teamId} is not in the seed`);
  const cert = teamCertification(teamId);
  const all: DeckSource = { documentId: `assessment:${teamId}:all`, title: `${team.name} scorecard — all dimensions` };
  const dimSrc = (id: string): DeckSource => ({ documentId: `assessment:${teamId}:${id}`, title: `Dimension ${id} — ${A.rubricDimension(id)?.title ?? id}`.slice(0, 160) });
  const below = cert.dims.filter((d) => d.current_level! < cert.target).sort((a, b) => a.current_level! - b.current_level!);
  const gaps = cert.dims.filter((d) => d.self_claimed_level !== null && d.self_claimed_level > d.current_level!)
    .sort((a, b) => (b.self_claimed_level! - b.current_level!) - (a.self_claimed_level! - a.current_level!));
  const widest = gaps[0];
  const levels = [1, 2, 3, 4, 5];
  const byLevel: DeckChart = {
    kind: 'bar', labels: levels.map((l) => `Level ${l}`),
    series: [
      { name: 'Verified', values: levels.map((l) => cert.dims.filter((d) => d.current_level === l).length) },
      { name: 'Claimed by the team', values: levels.map((l) => cert.dims.filter((d) => d.self_claimed_level === l).length) },
    ],
  };
  const top = cert.dims.filter((d) => d.current_level! > cert.target).sort((a, b) => b.current_level! - a.current_level!).slice(0, 3);
  const strong = cert.dims.filter((d) => d.current_level! > cert.target).map((d) => DIM_SHORT[d.dimension_id] ?? d.dimension_id);
  const lead = team.assessment_lead ?? 'The assessment lead';
  return spec('assessment', 'bold', `${team.name}: assessment readout`, `${A.COHORT_LABELS[team.cohort]} cohort · target Level ${cert.target}`, all, [
    {
      id: 'title', layout: 'title', title: t(`${cert.atOrAbove} of ${cert.assessed} `, ['at target', 'gradient']), eyebrow: `${team.name} · readout ${short(now)}`,
      bullets: [`Led by ${lead}`],
      notes: `Verified against a target of Level ${cert.target}. ${cert.applicable} dimensions apply to this team; ${cert.assessed} are assessed.`,
    },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['The scorecard', 'Claims and evidence', 'Strongest and weakest', 'Where to work next'] }, notes: 'Twenty minutes with the team, then questions.' },
    {
      id: 'figures', layout: 'key-figures', title: 'The scorecard in four numbers',
      figures: [
        { value: `${cert.atOrAbove} of ${cert.assessed}`, label: `Dimensions at Level ${cert.target} or above`, icon: 'circle-check' },
        { value: String(cert.below), label: 'Below target', icon: 'trending-down' },
        { value: String(cert.claimsOpen), label: 'Claims higher than the evidence', icon: 'circle-alert' },
        { value: `Level ${cert.highest}`, label: 'Highest verified level', icon: 'medal' },
      ],
      notes: 'Each number is counted from the verified scores, not the team\'s own ratings.',
    },
    {
      id: 'levels', layout: 'chart', title: 'Verified against claimed',
      chart: byLevel,
      notes: `How many dimensions sit at each level: what the evidence verifies, beside what the team claimed. The claimed bars lean right; ${cert.claimsOpen} claims are still open.`,
    },
    {
      id: 'gap', layout: 'big-number', title: t('The ', ['widest gap', 'accent']),
      figures: [{ value: `${widest!.self_claimed_level! - widest!.current_level!} levels`, label: `between claim and evidence on ${DIM_SHORT[widest!.dimension_id]?.toLowerCase()}`, context: `claimed ${widest!.self_claimed_level}, verified ${widest!.current_level}`, icon: 'crosshair' }],
      bullets: ['Ask for the artifact that would verify higher', 'Never re-score from the claim alone'],
      sources: [dimSrc(widest!.dimension_id)],
      notes: 'The plan ranks closing this claim first.',
    },
    {
      id: 'ends', layout: 'comparison', title: 'Strongest and weakest',
      comparison: {
        left: { title: 'Above target', icon: 'trophy', points: top.map((d) => `${DIM_SHORT[d.dimension_id]}: Level ${d.current_level}`) },
        right: { title: 'Furthest below', icon: 'triangle-alert', points: below.slice(0, 3).map((d) => `${DIM_SHORT[d.dimension_id]}: Level ${d.current_level}`) },
        verdict: `Close the gap on the lowest before raising the highest further.`,
      },
      sources: [...top, ...below.slice(0, 3)].map((d) => dimSrc(d.dimension_id)),
      notes: 'Verified levels only. Where several dimensions tie, the scorecard order decides.',
    },
    { id: 'section', layout: 'section', title: 'Where to work next', eyebrow: 'Part two', notes: 'From the scorecard to the plan.' },
    {
      id: 'below', layout: 'table', title: `Below Level ${cert.target}`,
      table: { header: ['Dimension', 'Verified', 'Claimed', 'Confidence'], rows: below.slice(0, 8).map((d) => [DIM_SHORT[d.dimension_id] ?? d.dimension_id, `Level ${d.current_level}`, d.self_claimed_level === null ? 'None' : `Level ${d.self_claimed_level}`, label(d.confidence)]) },
      sources: below.slice(0, 8).map((d) => dimSrc(d.dimension_id)),
      notes: 'Lowest verified level first.',
    },
    {
      id: 'plan', layout: 'cards', title: 'What the plan asks for',
      items: [
        { title: 'Close the open claims', text: `${cert.claimsOpen} dimensions where the team rates itself above the evidence`, icon: 'search' },
        { title: 'Lift what is below target', text: `${cert.below} dimensions under Level ${cert.target}`, icon: 'trending-up' },
        { title: 'Keep what is strong', text: strong.length ? `Above target: ${strong.slice(0, 3).join(', ')}` : `Hold the ${cert.atOrAbove} at target`, icon: 'shield-check' },
      ],
      notes: 'Counts from the verified scores; the plan page lists each recommendation with its story command.',
    },
    {
      id: 'closing', layout: 'closing', title: 'Next steps for the team',
      closing: { line: `Bring the evidence for the ${cert.claimsOpen} open claims.`, nextSteps: [`Start with ${DIM_SHORT[widest!.dimension_id]?.toLowerCase()}`, `Plan stories for the ${cert.below} dimensions below target`, `Review again with ${lead}`], contact: `${lead}, assessment lead` },
      notes: 'The readout ends on the team\'s own actions.',
    },
  ]);
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

const BUILD = {
  'auth-steering': authSteering, 'observability-review': observabilityReview,
  'soc2-readiness': soc2Readiness, 'rag-retrospective': ragRetrospective, 'northstar-readout': northstarReadout,
} as const;
export const SAMPLE_STYLES: Record<keyof typeof BUILD, DeckStyle> = {
  'auth-steering': 'corporate', 'observability-review': 'editorial', 'soc2-readiness': 'minimal', 'rag-retrospective': 'playful', 'northstar-readout': 'bold',
};

/** Created at 09:00 UTC some days ago, stable for the whole day so the deck and revision rows agree. */
const stamp = (daysAgo: number) => new Date(utcDayStartMs() - daysAgo * DAY_MS + 9 * HOUR_MS).toISOString();

export interface SampleDeck { key: keyof typeof BUILD; n: number; spec: DeckSpec; createdAt: string }
/** Every sample deck, built from the rows as they are now. */
export function buildSampleDeck(key: keyof typeof BUILD, n: number): SampleDeck {
  const createdAt = stamp(n);
  return { key, n, spec: BUILD[key](clock.nowIso()), createdAt };
}
export const SAMPLE_SUMMARY = 'A sample deck built from this record\'s seed data, to show what a finished deck looks like.';
