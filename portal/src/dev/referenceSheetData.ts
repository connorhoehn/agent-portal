// Fixture content for the dev-only reference sheet (/dev/reference-sheet).
// The library ships no story fixtures in dist, so the names here come from the
// middleware's mock org (middleware/src/mock: initiatives, people, teams) and the
// voice navigator's tool catalogue (docs/voice-navigator-spec.md §4), so the
// sheet reads like the product rather than placeholder text.

import type { SubNavItem, NotificationItem, PresenceAvatarUser } from '@connorhoehn/ui-components/shared';
import type { VoicePending, VoiceTurn } from '@connorhoehn/ui-components/voice';

export const noop = () => {};

// The orgiq primary rail as the shell draws it today (docs/design/layout-*.png).
export const PRIMARY_NAV: SubNavItem[] = [
  { path: '/iq/projects', label: 'Initiatives', group: 'Plan', count: 2 },
  { path: '/iq/decisions', label: 'Decisions', group: 'Plan' },
  { path: '/iq/designs', label: 'Designs', group: 'Design' },
  { path: '/iq/work', label: 'Automate', group: 'Build', activity: { label: '2 running' } },
  { path: '/iq/runbooks', label: 'Runbooks', group: 'Build' },
  { path: '/iq/library', label: 'Agent library', group: 'Build' },
  { path: '/iq/computers', label: 'Computers', group: 'Build' },
  { path: '/iq/search', label: 'Search', group: 'Engage' },
  { path: '/iq/communication', label: 'Communication', group: 'Engage' },
  { path: '/settings', label: 'Settings', group: 'System' },
];

export const SECTION_NAV: SubNavItem[] = [
  { path: '/dev/reference-sheet#overview', label: 'Overview' },
  { path: '/dev/reference-sheet#work', label: 'Work', count: 12 },
  { path: '/dev/reference-sheet#decisions', label: 'Decisions', count: 4 },
  { path: '/dev/reference-sheet#documents', label: 'Documents' },
  { path: '/dev/reference-sheet#people', label: 'People', count: 9 },
];

export const INITIATIVES = [
  { id: 'auth', name: 'Auth Migration', owner: 'Vera Green', status: 'active', contributors: 7, updated: '12 min ago' },
  { id: 'rag', name: 'RAG Knowledge Search', owner: 'Priya Venkataraman', status: 'active', contributors: 5, updated: '1 h ago' },
  { id: 'mlfs', name: 'ML Feature Store', owner: 'Theo Chang', status: 'active', contributors: 6, updated: '3 h ago' },
  { id: 'zt', name: 'Zero Trust Network', owner: 'Omar Haddad', status: 'at-risk', contributors: 4, updated: 'yesterday' },
  { id: 'soc2', name: 'SOC2 Compliance', owner: 'Martina Kovacs', status: 'blocked', contributors: 3, updated: '2 days ago' },
  { id: 'obs', name: 'Observability Platform', owner: 'Sam Okafor', status: 'done', contributors: 8, updated: 'last week' },
] as const;

export type Initiative = (typeof INITIATIVES)[number];

export const STATUS_TONE: Record<Initiative['status'], 'success' | 'warning' | 'error' | 'neutral'> = {
  active: 'success', 'at-risk': 'warning', blocked: 'error', done: 'neutral',
};

export const PEOPLE: PresenceAvatarUser[] = [
  { id: 'p-vera', name: 'Vera Green', online: true },
  { id: 'p-theo', name: 'Theo Chang', online: true },
  { id: 'p-priya', name: 'Priya Venkataraman', online: true },
  { id: 'p-omar', name: 'Omar Haddad', online: true, idle: true },
  { id: 'p-nora', name: 'Nora DaSilva', online: true },
  { id: 'p-sam', name: 'Sam Okafor', online: false },
  { id: 'p-rhea', name: 'Rhea Castellanos', online: true },
];

export const NOTIFICATIONS: NotificationItem[] = [
  { id: 'n1', title: 'Theo Chang mentioned you in #platform-engineering', body: 'Can you look at the feature store rollout plan before Thursday?', timestamp: Date.now() - 4 * 60_000, category: 'mention' },
  { id: 'n2', title: 'Missed huddle: Auth Migration', body: 'Vera Green, Omar Haddad · 6 min', timestamp: Date.now() - 50 * 60_000, category: 'call' },
  { id: 'n3', title: 'Access request approved', body: 'Read access to the analytics warehouse', timestamp: Date.now() - 3 * 3_600_000, read: true, category: 'approval' },
];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const MESSAGES = [
  { clientId: 'm1', id: 'm1', userId: 'p-vera', displayName: 'Vera Green', content: 'Token exchange is live in staging. Cutover window is Thursday 9:00.', timestamp: minutesAgo(42) },
  { clientId: 'm2', id: 'm2', userId: 'p-omar', displayName: 'Omar Haddad', content: 'Network policy for the new issuer is merged. I will watch the error budget.', timestamp: minutesAgo(31) },
  { clientId: 'm3', id: 'm3', userId: 'demo-user', displayName: 'Demo User', content: 'Thanks both. I will start a computer for the load test.', timestamp: minutesAgo(5) },
];

export const PENDING: VoicePending = {
  title: 'Start a computer in 3 projects',
  detail: 'Auth Migration, RAG Knowledge Search, ML Feature Store. Each computer bills idle time until it is stopped.',
  onConfirm: noop,
  onCancel: noop,
};

export const TURNS: VoiceTurn[] = [
  { id: 't1', role: 'you', at: '09:41', text: 'Open the computer lab and start a VM in each of my active projects.' },
  {
    id: 't2', role: 'assistant', at: '09:41',
    text: 'You have three active initiatives. Starting a computer in each needs your OK.',
    toolCalls: [
      { name: 'list', status: 'done', summary: '3 initiatives; first: Alpha' },
      { name: 'open', status: 'done', summary: 'Opened Computer Lab' },
    ],
  },
  { id: 't3', role: 'you', at: '09:42', text: 'Yes. And tell the platform team I am out this afternoon.' },
  {
    id: 't4', role: 'assistant', at: '09:42',
    text: 'Starting the computers now. Posting to a team channel needs its own confirmation.',
    toolCalls: [
      { name: 'computer', status: 'running', summary: 'Auth Migration, 1 of 3' },
      { name: 'message', status: 'refused', summary: 'not confirmed: #platform-engineering' },
    ],
  },
];

export const TURNS_FAILED: VoiceTurn[] = [
  { id: 'f1', role: 'you', at: '10:05', text: 'Has there been any issue with the bot sweeps since yesterday?' },
  {
    id: 'f2', role: 'assistant', at: '10:05',
    text: 'Two open findings from stale_docs. The bus_factor sweep did not answer.',
    toolCalls: [
      { name: 'summary', status: 'done', summary: '2 open findings' },
      { name: 'summary', status: 'failed', summary: 'Could not read the sweeps, findings or bot runs.' },
    ],
  },
];

/** The colour tokens the portal paints with (portal/src/app.css @theme). */
export const COLOR_TOKENS: { group: string; tokens: { name: string; swatch: string }[] }[] = [
  {
    group: 'Brand and text',
    tokens: [
      { name: '--color-primary', swatch: 'bg-[var(--color-primary)]' },
      { name: '--color-primary-hover', swatch: 'bg-[var(--color-primary-hover)]' },
      { name: '--color-primary-soft', swatch: 'bg-[var(--color-primary-soft)]' },
      { name: '--color-brand-ink', swatch: 'bg-[var(--color-brand-ink)]' },
      { name: '--color-text-primary', swatch: 'bg-[var(--color-text-primary)]' },
      { name: '--color-text-secondary', swatch: 'bg-[var(--color-text-secondary)]' },
      { name: '--color-text-tertiary', swatch: 'bg-[var(--color-text-tertiary)]' },
      { name: '--color-text-disabled', swatch: 'bg-[var(--color-text-disabled)]' },
    ],
  },
  {
    group: 'Surfaces and borders',
    tokens: [
      { name: '--color-bg', swatch: 'bg-[var(--color-bg)]' },
      { name: '--color-surface', swatch: 'bg-[var(--color-surface)]' },
      { name: '--color-surface-panel', swatch: 'bg-[var(--color-surface-panel)]' },
      { name: '--color-surface-inset', swatch: 'bg-[var(--color-surface-inset)]' },
      { name: '--color-surface-hover', swatch: 'bg-[var(--color-surface-hover)]' },
      { name: '--color-surface-subtle', swatch: 'bg-[var(--color-surface-subtle)]' },
      { name: '--color-border', swatch: 'bg-[var(--color-border)]' },
      { name: '--color-border-emphasis', swatch: 'bg-[var(--color-border-emphasis)]' },
    ],
  },
  {
    group: 'Status',
    tokens: [
      { name: '--color-success', swatch: 'bg-[var(--color-success)]' },
      { name: '--color-success-bg', swatch: 'bg-[var(--color-success-bg)]' },
      { name: '--color-warning', swatch: 'bg-[var(--color-warning)]' },
      { name: '--color-warning-bg', swatch: 'bg-[var(--color-warning-bg)]' },
      { name: '--color-danger', swatch: 'bg-[var(--color-danger)]' },
      { name: '--color-danger-bg', swatch: 'bg-[var(--color-danger-bg)]' },
      { name: '--color-info', swatch: 'bg-[var(--color-info)]' },
      { name: '--color-info-bg', swatch: 'bg-[var(--color-info-bg)]' },
    ],
  },
  {
    group: 'Run states and tenants',
    tokens: [
      { name: '--color-state-idle', swatch: 'bg-[var(--color-state-idle)]' },
      { name: '--color-state-pending', swatch: 'bg-[var(--color-state-pending)]' },
      { name: '--color-state-running', swatch: 'bg-[var(--color-state-running)]' },
      { name: '--color-state-awaiting', swatch: 'bg-[var(--color-state-awaiting)]' },
      { name: '--color-state-completed', swatch: 'bg-[var(--color-state-completed)]' },
      { name: '--color-state-failed', swatch: 'bg-[var(--color-state-failed)]' },
      { name: '--color-tenant-social', swatch: 'bg-[var(--color-tenant-social)]' },
      { name: '--color-optimize', swatch: 'bg-[var(--color-optimize)]' },
    ],
  },
];
