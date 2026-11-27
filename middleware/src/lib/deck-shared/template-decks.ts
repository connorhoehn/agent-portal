// Five example decks as data (docs/deck-edit-operations.md, "Templates"). Each
// is a complete, valid deck in the engine's format, written about one invented
// organisation (Kestrel Lane, a regional parcel co-operative) so the examples
// read like real work. Nothing here names a real person, company or number.
//
// Every slide cites the template itself as an example source
// (`example:template:<id>`). The format accepts it as it accepts any source, so
// a deck made from a template saves as it is; previews and the edit-operations
// answer name each slide still citing only the example, so the page and the
// voice assistant can ask for the real document (lib/deck-shared/operations.ts).
//
// A test lays every template out under every tenant theme and the built-in
// themes and fails on any finding (__tests__/templates.test.ts).

import type { DeckSlide, DeckSource, DeckSpec } from '@connorhoehn/realtime-modules/deck';

export interface DeckTemplate {
  id: string;
  title: string;
  description: string;
  audience: string;
  spec: DeckSpec;
}

const src = (id: string, name: string): DeckSource[] => [{ documentId: `example:template:${id}`, title: `Example content from the ${name} template` }];

function deck(id: string, name: string, spec: { title: string; subtitle?: string; slides: Array<Omit<DeckSlide, 'sources'>> }): DeckSpec {
  return { title: spec.title, ...(spec.subtitle ? { subtitle: spec.subtitle } : {}), slides: spec.slides.map((s) => ({ ...s, sources: src(id, name) })) };
}

const STATUS = deck('status-update', 'Status update', {
  title: 'Route planner rollout: status for March',
  subtitle: 'Kestrel Lane operations programme',
  slides: [
    { id: 'title', layout: 'title', title: 'Route planner rollout', eyebrow: 'Status update · March' },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['Where we are', 'Numbers this month', 'What comes next', 'Decisions we need'], current: 0 } },
    {
      id: 'figures', layout: 'key-figures', title: 'Numbers this month',
      figures: [
        { value: '14 of 22', label: 'Depots on the new planner', delta: '+5 since February' },
        { value: '11%', label: 'Fewer empty van miles', delta: '+3 pts' },
        { value: '2', label: 'Open blocking issues' },
      ],
    },
    {
      id: 'chart', layout: 'chart', title: 'Depots live by week',
      chart: { kind: 'bar', labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], series: [{ name: 'Depots live', values: [9, 10, 12, 14] }] },
    },
    {
      id: 'timeline', layout: 'timeline', title: 'What comes next',
      timeline: [
        { date: 'Apr 4', label: 'Northern depots', detail: 'Four depots move over in one weekend' },
        { date: 'Apr 18', label: 'Driver app update', detail: 'Live re-routing reaches every van' },
        { date: 'May 2', label: 'Last depots', detail: 'The old planner is switched off' },
      ],
    },
    { id: 'floor', layout: 'image', title: 'The new dispatch desk', image: { alt: 'Photo of the dispatch desk at the Eastgate depot' } },
    {
      id: 'closing', layout: 'closing', title: 'Decisions we need',
      closing: { line: 'Two decisions keep the May date.', nextSteps: ['Approve weekend overtime for the northern move', 'Choose the driver app release day'], contact: 'Operations programme office' },
    },
  ],
});

const PROPOSAL = deck('proposal', 'Proposal', {
  title: 'Proposal: electric vans for city routes',
  subtitle: 'Kestrel Lane fleet group',
  slides: [
    { id: 'title', layout: 'title', title: 'Electric vans for city routes', eyebrow: 'Proposal' },
    { id: 'section', layout: 'section', title: 'The choice in front of us', eyebrow: 'Part one' },
    {
      id: 'compare', layout: 'comparison', title: 'Lease or buy',
      comparison: {
        left: { title: 'Lease', points: ['Lower cost in year one', 'Maintenance is included', 'Fleet is renewed every four years'] },
        right: { title: 'Buy', points: ['Lower cost over eight years', 'We keep the resale value', 'Depots need their own workshop'] },
        verdict: 'Lease the first twenty vans, then decide with a year of data.',
      },
    },
    {
      id: 'table', layout: 'table', title: 'What the first year costs',
      table: {
        header: ['Item', 'Lease', 'Buy'],
        rows: [['Vans', 'Monthly fee', 'Up front'], ['Chargers', 'Installed by us', 'Installed by us'], ['Servicing', 'Included', 'Our workshop'], ['Insurance', 'Ours', 'Ours']],
      },
    },
    {
      id: 'timeline', layout: 'timeline', title: 'How it would roll out',
      timeline: [
        { date: 'June', label: 'Chargers at two depots' },
        { date: 'August', label: 'First ten vans in service' },
        { date: 'October', label: 'Twenty vans in service' },
        { date: 'Next June', label: 'Review and decide on buying' },
      ],
    },
    {
      id: 'closing', layout: 'closing', title: 'What we are asking for',
      closing: { line: 'Approve a one-year lease of twenty vans.', nextSteps: ['Board decision at the May meeting', 'Charger survey at both depots'], contact: 'Fleet group' },
    },
  ],
});

const REVIEW = deck('review', 'Review', {
  title: 'Quarterly review: customer service',
  subtitle: 'Kestrel Lane, first quarter',
  slides: [
    { id: 'title', layout: 'title', title: 'Customer service review', eyebrow: 'First quarter' },
    {
      id: 'figures', layout: 'key-figures', title: 'The quarter in figures',
      figures: [
        { value: '4.2 of 5', label: 'Average customer rating', delta: '+0.3' },
        { value: '6 hours', label: 'Median time to answer', delta: '-2 hours' },
        { value: '93%', label: 'Parcels on time' },
        { value: '1,180', label: 'Complaints logged' },
      ],
    },
    {
      id: 'bullets', layout: 'bullets', title: 'What we learned',
      bullets: ['Most complaints were about missed delivery windows', 'Customers who got a text update rated us higher', 'Weekend answers were slower than weekday ones'],
    },
    {
      id: 'pie', layout: 'chart', title: 'Complaints by reason',
      chart: { kind: 'pie', labels: ['Late delivery', 'Damaged parcel', 'Wrong address', 'Billing', 'Other'], series: [{ name: 'Complaints', values: [520, 240, 190, 130, 100] }] },
    },
    {
      id: 'two', layout: 'two-column', title: 'Keep and change',
      columns: [['Keep the delivery text updates', 'Keep the callback promise'], ['Add weekend answer cover', 'Show the delivery window on the label']],
    },
    { id: 'quote', layout: 'quote', title: 'In a customer\'s words', quote: { text: 'The text telling me the van was ten minutes away made all the difference.', by: 'A customer survey answer' } },
  ],
});

const DEBRIEF = deck('interview-debrief', 'Interview debrief', {
  title: 'Debrief: depot manager interviews',
  subtitle: 'Kestrel Lane hiring panel',
  slides: [
    { id: 'title', layout: 'title', title: 'Depot manager interviews', eyebrow: 'Panel debrief' },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['The role and what we looked for', 'The two finalists', 'Scores by area', 'Our recommendation'], current: 1 } },
    {
      id: 'compare', layout: 'comparison', title: 'The two finalists',
      comparison: {
        left: { title: 'Candidate A', points: ['Ran a depot of forty drivers', 'Strong on safety records', 'New to route planning tools'] },
        right: { title: 'Candidate B', points: ['Led a regional planning team', 'Strong on scheduling', 'Has not managed a depot floor'] },
        verdict: 'Both meet the bar; the panel leans towards Candidate A.',
      },
    },
    {
      id: 'table', layout: 'table', title: 'Scores by area',
      table: {
        header: ['Area', 'Candidate A', 'Candidate B'],
        rows: [['Leading a team', 'Strong', 'Good'], ['Safety', 'Strong', 'Good'], ['Planning', 'Good', 'Strong'], ['Working with drivers', 'Strong', 'Good']],
      },
    },
    {
      id: 'closing', layout: 'closing', title: 'Our recommendation',
      closing: { line: 'Offer the role to Candidate A.', nextSteps: ['Reference checks this week', 'Planning tool training in the first month'], contact: 'Hiring panel' },
    },
  ],
});

const RUN = deck('run-report', 'Run report', {
  title: 'Run report: nightly address clean-up',
  subtitle: 'Kestrel Lane data pipeline',
  slides: [
    { id: 'title', layout: 'title', title: 'Nightly address clean-up', eyebrow: 'Run report · last 7 nights' },
    {
      id: 'figures', layout: 'key-figures', title: 'The week at a glance',
      figures: [
        { value: '7 of 7', label: 'Nights that finished' },
        { value: '41,200', label: 'Addresses checked' },
        { value: '1.7%', label: 'Addresses changed', delta: '-0.4 pts' },
      ],
    },
    {
      id: 'stacked', layout: 'chart', title: 'Addresses changed, per night',
      chart: {
        kind: 'stacked-bar', labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        series: [
          { name: 'Postcode fixed', values: [52, 48, 45, 58, 50, 44, 41] },
          { name: 'Street name fixed', values: [46, 45, 41, 50, 40, 42, 38] },
          { name: 'Needs a person', values: [12, 9, 14, 11, 10, 8, 7] },
        ],
      },
    },
    {
      id: 'table', layout: 'table', title: 'Steps and their times',
      table: {
        header: ['Step', 'Median time', 'Slowest night'],
        rows: [['Load new orders', '4 min', 'Fri, 6 min'], ['Match postcodes', '11 min', 'Mon, 15 min'], ['Correct and flag', '7 min', 'Thu, 9 min'], ['Publish to depots', '2 min', 'Sat, 3 min']],
      },
    },
  ],
});

export const DECK_TEMPLATES: readonly DeckTemplate[] = [
  { id: 'status-update', title: 'Status update', description: 'Where a piece of work stands: agenda, key figures, progress chart, what comes next and the decisions needed.', audience: 'Sponsors and steering groups', spec: STATUS },
  { id: 'proposal', title: 'Proposal', description: 'A choice laid out for a decision: the options side by side, their costs, a plan and the ask.', audience: 'Decision makers and budget holders', spec: PROPOSAL },
  { id: 'review', title: 'Review', description: 'A look back over a period: the figures, what was learned, a breakdown and what to keep or change.', audience: 'Teams and their leads', spec: REVIEW },
  { id: 'interview-debrief', title: 'Interview debrief', description: 'A hiring panel\'s summary: finalists compared, scores by area and a recommendation.', audience: 'Hiring panels and managers', spec: DEBRIEF },
  { id: 'run-report', title: 'Run report', description: 'How a recurring job ran: the headline figures, results per run and step timings.', audience: 'Operators and engineers', spec: RUN },
];
