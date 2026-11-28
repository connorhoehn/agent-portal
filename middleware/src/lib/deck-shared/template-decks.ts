// Eight example decks as data (docs/deck-edit-operations.md, "Templates"). Each
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
// Between them they use every layout but the picture ones (there is no asset
// store yet), all five styles, icons on cards, steps and figures, emphasis runs
// in a few titles and a decoration where the style's own motif is not enough.
//
// A test lays every template out under every tenant theme and the built-in
// themes and fails on any finding (__tests__/templates.test.ts).

import type { DeckSlide, DeckSource, DeckSpec } from '@connorhoehn/realtime-modules/deck';
import type { DeckStyle } from '@connorhoehn/realtime-modules/deck/layout';

export interface DeckTemplate {
  id: string;
  title: string;
  description: string;
  audience: string;
  /** The composition style the template is designed in (a deck made from it keeps it until set_style). */
  style: DeckStyle;
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
    { id: 'title', layout: 'title', title: [{ text: 'Route planner rollout: ' }, { text: 'on track', emphasis: 'accent' }], eyebrow: 'Status update · March', bullets: ['Fourteen depots live, eight to go before the May switch-off'] },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['Where we are', 'Numbers this month', 'What comes next', 'Decisions we need'], current: 0 } },
    {
      id: 'kpi', layout: 'kpi', title: 'Numbers this month',
      figures: [
        { value: '14 of 22', label: 'Depots on the new planner', delta: '+5 since February', icon: 'warehouse' },
        { value: '11%', label: 'Fewer empty van miles', delta: '+3 pts', icon: 'truck' },
        { value: '2', label: 'Open blocking issues', icon: 'triangle-alert' },
      ],
      chart: { kind: 'bar', labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'], series: [{ name: 'Depots live', values: [9, 10, 12, 14] }] },
    },
    {
      id: 'process', layout: 'process', title: 'How a depot moves over',
      items: [
        { title: 'Map the routes', text: 'Planners load a month of real drops into the new tool', icon: 'map' },
        { title: 'Run in parallel', text: 'Both planners run for one week and the routes are compared', icon: 'split' },
        { title: 'Train drivers', text: 'Each driver gets a short session on the new app', icon: 'graduation-cap' },
        { title: 'Switch over', text: 'The depot plans on the new tool only from Monday', icon: 'circle-check' },
      ],
    },
    {
      id: 'timeline', layout: 'timeline', title: 'What comes next',
      timeline: [
        { date: 'Apr 4', label: 'Northern depots', detail: 'Four depots move over in one weekend' },
        { date: 'Apr 18', label: 'Driver app update', detail: 'Live re-routing reaches every van' },
        { date: 'May 2', label: 'Last depots', detail: 'The old planner is switched off' },
      ],
      decoration: { graphic: 'timeline', placement: 'title' },
    },
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
    { id: 'title', layout: 'title', title: [{ text: 'Electric vans for ' }, { text: 'city routes', emphasis: 'gradient' }], eyebrow: 'Proposal to the board' },
    {
      id: 'big', layout: 'big-number', title: 'Why now',
      figures: [{ value: '38%', label: 'of our van miles are inside the city low-emission zone', context: 'up from 21% two years ago', icon: 'leaf' }],
      bullets: ['The zone charge doubles next spring', 'Three customers now ask for zero-emission delivery in their tenders'],
    },
    {
      id: 'compare', layout: 'comparison', title: 'Lease or buy',
      comparison: {
        left: { title: 'Lease', icon: 'refresh-cw', points: ['Lower cost in year one', 'Maintenance is included', 'Fleet is renewed every four years'] },
        right: { title: 'Buy', icon: 'piggy-bank', points: ['Lower cost over eight years', 'We keep the resale value', 'Depots need their own workshop'] },
        verdict: 'Lease the first twenty vans, then decide with a year of data.',
      },
    },
    {
      id: 'matrix', layout: 'matrix', title: 'Which routes go electric first',
      matrix: {
        x: ['Short daily miles', 'Long daily miles'], y: ['Few stops', 'Many stops'],
        quadrants: [
          { title: 'Second wave', text: 'Suburban rounds with long gaps', icon: 'clock' },
          { title: 'Keep diesel for now', text: 'Regional trunk runs', icon: 'route' },
          { title: 'First wave', text: 'Dense city-centre rounds', icon: 'zap' },
          { title: 'Needs a mid-day charge', text: 'Long multi-drop rounds', icon: 'plug' },
        ],
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
    { id: 'title', layout: 'title', title: 'Customer service review', eyebrow: 'First quarter', bullets: ['What customers told us, and what we will change'] },
    {
      id: 'figures', layout: 'key-figures', title: 'The quarter in figures',
      figures: [
        { value: '4.2 of 5', label: 'Average customer rating', delta: '+0.3', icon: 'star' },
        { value: '6 hours', label: 'Median time to answer', delta: '-2 hours', icon: 'timer' },
        { value: '93%', label: 'Parcels on time', icon: 'package' },
        { value: '1,180', label: 'Complaints logged', icon: 'message-square' },
      ],
    },
    {
      id: 'cards', layout: 'cards', title: [{ text: 'What we ' }, { text: 'learned', emphasis: 'underline' }],
      items: [
        { title: 'Windows matter most', text: 'Most complaints were about missed delivery windows, not lost parcels', icon: 'calendar-check' },
        { title: 'A text calms people', text: 'Customers who got a text update rated us almost a point higher', icon: 'smartphone' },
        { title: 'Weekends lag', text: 'Weekend answers took twice as long as weekday ones', icon: 'hourglass' },
      ],
    },
    {
      id: 'pie', layout: 'chart', title: 'Complaints by reason',
      chart: { kind: 'pie', labels: ['Late delivery', 'Damaged parcel', 'Wrong address', 'Billing', 'Other'], series: [{ name: 'Complaints', values: [520, 240, 190, 130, 100] }] },
    },
    {
      id: 'keep', layout: 'comparison', title: 'Keep and change',
      comparison: {
        left: { title: 'Keep', icon: 'thumbs-up', points: ['The delivery text updates', 'The callback promise'] },
        right: { title: 'Change', icon: 'refresh-cw', points: ['Add weekend answer cover', 'Show the delivery window on the label'] },
        verdict: 'Weekend cover first: it is the slowest answer we give.',
      },
    },
    { id: 'quote', layout: 'quote', title: 'In a customer\'s words', quote: { text: 'The text telling me the van was ten minutes away made all the difference.', by: 'A customer survey answer, February' } },
  ],
});

const DEBRIEF = deck('interview-debrief', 'Interview debrief', {
  title: 'Debrief: depot manager interviews',
  subtitle: 'Kestrel Lane hiring panel',
  slides: [
    { id: 'title', layout: 'title', title: 'Depot manager interviews', eyebrow: 'Panel debrief' },
    { id: 'agenda', layout: 'agenda', title: 'Agenda', agenda: { items: ['The panel', 'The two finalists', 'Scores by area', 'Our recommendation'], current: 1 } },
    {
      id: 'panel', layout: 'people', title: 'The panel',
      people: [
        { name: 'Priya Okafor', role: 'Head of depot operations', detail: 'Chaired all six interviews' },
        { name: 'Tom Lindqvist', role: 'Eastgate depot manager', detail: 'Ran the floor walk' },
        { name: 'Grace Mbeki', role: 'People partner', detail: 'Led the values questions' },
      ],
    },
    {
      id: 'questions', layout: 'two-column', title: 'What we asked both finalists',
      columns: [['Walk us through a shift that went wrong', 'How do you plan a peak week?', 'Tell us about a driver you coached'], ['What would you change in your first month?', 'How do you check a safety record?', 'When did you push back on a plan?']],
    },
    {
      id: 'compare', layout: 'comparison', title: 'The two finalists',
      comparison: {
        left: { title: 'Candidate A', icon: 'shield-check', points: ['Ran a depot of forty drivers', 'Strong on safety records', 'New to route planning tools'] },
        right: { title: 'Candidate B', icon: 'route', points: ['Led a regional planning team', 'Strong on scheduling', 'Has not managed a depot floor'] },
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
      id: 'closing', layout: 'closing', title: [{ text: 'Our recommendation: ' }, { text: 'Candidate A', emphasis: 'highlight' }],
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
        { value: '7 of 7', label: 'Nights that finished', icon: 'circle-check' },
        { value: '41,200', label: 'Addresses checked', icon: 'map-pin' },
        { value: '1.7%', label: 'Addresses changed', delta: '-0.4 pts', icon: 'pen-line' },
      ],
    },
    {
      id: 'funnel', layout: 'funnel', title: 'From new orders to clean addresses',
      funnel: [
        { label: 'Addresses checked', value: '41,200' },
        { label: 'Looked wrong', value: '1,310', detail: 'Postcode or street did not match' },
        { label: 'Fixed automatically', value: '1,240', detail: 'Matched to the postal file' },
        { label: 'Sent to a person', value: '70', detail: 'Reviewed by the address desk' },
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

const QBR = deck('quarterly-business-review', 'Quarterly business review', {
  title: 'Quarterly business review: third quarter',
  subtitle: 'Kestrel Lane leadership team',
  slides: [
    { id: 'title', layout: 'title', title: [{ text: 'Third quarter: ' }, { text: 'volume up, cost flat', emphasis: 'accent' }], eyebrow: 'Quarterly business review', bullets: ['For the leadership team, October'] },
    {
      id: 'big', layout: 'big-number', title: 'The headline',
      figures: [{ value: '2.4m', label: 'parcels delivered this quarter', context: '12% more than the third quarter last year', icon: 'package' }],
      bullets: ['Cost per parcel held at last year\'s level', 'Two new retail customers went live in August'],
    },
    {
      id: 'kpi', layout: 'kpi', title: 'Volume and cost by month',
      figures: [
        { value: '£1.86', label: 'Cost per parcel', delta: 'flat on last year', icon: 'coins' },
        { value: '96.1%', label: 'Delivered first time', delta: '+1.2 pts', icon: 'thumbs-up' },
      ],
      chart: { kind: 'line', labels: ['July', 'August', 'September'], series: [{ name: 'Parcels (thousands)', values: [760, 810, 830] }, { name: 'Last year', values: [690, 720, 735] }] },
    },
    {
      id: 'section', layout: 'section', title: 'Where we go next', eyebrow: 'Part two',
    },
    {
      id: 'cards', layout: 'cards', title: 'Priorities for the fourth quarter',
      items: [
        { title: 'Peak season ready', text: 'Hire and train 140 seasonal drivers by mid-November', icon: 'users' },
        { title: 'Electric city rounds', text: 'First ten electric vans in service at the two city depots', icon: 'zap' },
        { title: 'Fewer failed drops', text: 'Safe-place photos on every doorstep delivery', icon: 'house' },
      ],
    },
    {
      id: 'closing', layout: 'closing', title: 'What we need from this room',
      closing: { line: 'Agree the peak hiring budget today.', nextSteps: ['Sign off 140 seasonal drivers', 'Confirm the safe-place photo rollout date'], contact: 'Finance and operations' },
    },
  ],
});

const KICKOFF = deck('project-kickoff', 'Project kickoff', {
  title: 'Kickoff: same-day collection pilot',
  subtitle: 'Kestrel Lane new services team',
  slides: [
    { id: 'title', layout: 'title', title: [{ text: 'Same-day collection: ' }, { text: 'let\'s go', emphasis: 'highlight' }], eyebrow: 'Project kickoff', bullets: ['A six-week pilot with forty local shops'] },
    {
      id: 'cards', layout: 'cards', title: 'What we are building',
      items: [
        { title: 'Book by noon', text: 'Shops book a collection in the app before midday', icon: 'smartphone' },
        { title: 'Picked up by four', text: 'The nearest van collects on its afternoon round', icon: 'truck' },
        { title: 'Delivered next morning', text: 'Parcels join the overnight sort and arrive by ten', icon: 'sun' },
      ],
    },
    {
      id: 'team', layout: 'people', title: 'Who is on the team',
      people: [
        { name: 'Ana Ruiz', role: 'Product lead', detail: 'Owns the pilot and its results' },
        { name: 'Marcus Chen', role: 'Engineering lead', detail: 'Booking app and van routing' },
        { name: 'Ellie Haddad', role: 'Shop partnerships', detail: 'Signs up the forty shops' },
        { name: 'Joe Barker', role: 'Depot supervisor', detail: 'Runs the afternoon rounds' },
      ],
    },
    {
      id: 'process', layout: 'process', title: 'How the six weeks run',
      items: [
        { title: 'Weeks 1 and 2', text: 'Sign up shops and build the booking screen', icon: 'handshake' },
        { title: 'Week 3', text: 'Dry run with five friendly shops', icon: 'flag' },
        { title: 'Weeks 4 and 5', text: 'All forty shops book for real', icon: 'rocket' },
        { title: 'Week 6', text: 'Measure, decide and write it up', icon: 'chart-line' },
      ],
    },
    {
      id: 'kpis', layout: 'key-figures', title: 'How we will know it worked',
      figures: [
        { value: '30', label: 'Shops booking every week', icon: 'store' },
        { value: '95%', label: 'Collected on the same day', icon: 'clock' },
        { value: '4 of 5', label: 'Shops who would pay for it', icon: 'thumbs-up' },
      ],
    },
    {
      id: 'closing', layout: 'closing', title: 'First steps this week',
      closing: { line: 'Shops and screens first.', nextSteps: ['Shortlist the forty shops by Friday', 'First booking screen in review by Thursday'], contact: 'New services team' },
    },
  ],
});

const STORY = deck('customer-story', 'Customer story', {
  title: 'Customer story: Fernhill Bakery',
  subtitle: 'Kestrel Lane customer team',
  slides: [
    { id: 'title', layout: 'title', title: 'Fernhill Bakery, twice the orders', eyebrow: 'Customer story', bullets: ['How a small bakery doubled its online orders in six months'] },
    {
      id: 'challenge', layout: 'bullets', title: 'The challenge',
      bullets: ['Fresh bread has to arrive the day after it is baked', 'Couriers collected late, so orders shipped a day behind', 'Customers left reviews about stale loaves'],
    },
    {
      id: 'process', layout: 'process', title: 'What we did together',
      items: [
        { title: 'Early collection', text: 'A van calls at the bakery at seven every evening', icon: 'alarm-clock' },
        { title: 'Priority sort', text: 'Bakery parcels go on the first trunk run of the night', icon: 'layers' },
        { title: 'Morning delivery', text: 'Every loaf arrives before eleven the next day', icon: 'sun' },
      ],
    },
    {
      id: 'big', layout: 'big-number', title: [{ text: 'The result: ' }, { text: 'twice the orders', emphasis: 'bold' }],
      figures: [{ value: '2.1x', label: 'online orders, six months on', context: 'compared with the six months before', icon: 'trending-up' }],
      bullets: ['Stale-bread reviews stopped within a month'],
    },
    { id: 'quote', layout: 'big-quote', title: 'In their words', quote: { text: 'Our loaves now arrive tasting like they left the oven an hour ago. Our customers noticed before we told them.', by: 'Owner, Fernhill Bakery' } },
    {
      id: 'closing', layout: 'closing', title: 'What other bakers can take from it',
      closing: { line: 'Collect late, sort first, deliver early.', nextSteps: ['Offer evening collection to the twelve bakeries on our books', 'Share this story at the regional food fair'], contact: 'Customer team' },
    },
  ],
});

export const DECK_TEMPLATES: readonly DeckTemplate[] = [
  { id: 'status-update', title: 'Status update', description: 'Where a piece of work stands: headline figures over a progress chart, how the work moves, what comes next and the decisions needed.', audience: 'Sponsors and steering groups', style: 'corporate', spec: STATUS },
  { id: 'proposal', title: 'Proposal', description: 'A choice laid out for a decision: why now, the options side by side, where to start, the costs, a plan and the ask.', audience: 'Decision makers and budget holders', style: 'bold', spec: PROPOSAL },
  { id: 'review', title: 'Review', description: 'A look back over a period: the figures, what was learned, a breakdown, what to keep or change, and a voice from outside.', audience: 'Teams and their leads', style: 'editorial', spec: REVIEW },
  { id: 'interview-debrief', title: 'Interview debrief', description: 'A hiring panel\'s summary: who sat on the panel, what was asked, the finalists compared, scores by area and a recommendation.', audience: 'Hiring panels and managers', style: 'minimal', spec: DEBRIEF },
  { id: 'run-report', title: 'Run report', description: 'How a recurring job ran: the headline figures, what it caught at each stage, results per run and step timings.', audience: 'Operators and engineers', style: 'minimal', spec: RUN },
  { id: 'quarterly-business-review', title: 'Quarterly business review', description: 'A quarter for the leadership team: the headline number, volume and cost by month, next quarter\'s priorities and the decision needed.', audience: 'Leadership teams', style: 'corporate', spec: QBR },
  { id: 'project-kickoff', title: 'Project kickoff', description: 'The start of a piece of work: what is being built, who is on the team, how the weeks run and how success is measured.', audience: 'A new project team and its sponsor', style: 'playful', spec: KICKOFF },
  { id: 'customer-story', title: 'Customer story', description: 'One customer\'s problem, what was done about it, the result in one number and their own words.', audience: 'Sales, marketing and the wider company', style: 'editorial', spec: STORY },
];
