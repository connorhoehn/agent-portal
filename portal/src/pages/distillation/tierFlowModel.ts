// The tier-flow strip (L0 → Compact → L1 → Compact → L2 → Publish → Library)
// and the Activity status line, from GET /api/distillation/levels (spec §3a)
// plus the Library's linked-artifact count.
//
// Health-driven, never inferred: a tier is behind or stalled only because the
// server said so (`health.state`, or the pre-redesign `health[]` verdicts when
// a level has none). `lastCompletedAt` is only ever the "Last run 12h ago"
// clause — an old timestamp with an `ok` verdict is a quiet tier, not a
// problem, and a missing verdict is unknown, not healthy.
//
// Pure: no React. The Activity page hands `items`/`connectors` to StatStrip,
// `attention` to its Banner, and `activityDot` to the ScopeHeader tab.

import { parsePgTimestamp } from '../../lib/pgTimestamp.ts';
import { lagLabel } from './distillationFormat.ts';
import { activityHref, knowledgeHref, viewForLevel } from './distillationRoutes.ts';
import type { Level, LevelHealth, TierHealth, TierHealthState, TierLevel } from './types.ts';

export type FlowTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Resolved verdict: the three server states plus 'unknown' (no verdict). */
export type TierVerdict = TierHealthState | 'unknown';

export interface TierFlowItem {
  id: Level | 'library';
  /** "Run notes" · "Patterns" · "Guides & findings" · "Library". */
  label: string;
  /** Tier code shown with the label; null for Library. */
  level: Level | null;
  /** null = the server did not say; render as unknown, never 0. */
  value: number | null;
  /** Line under the number ("50m behind", "Stalled", "3 writing"). */
  status?: { label: string; tone: FlowTone };
  verdict: TierVerdict;
  /** Server's sentence for a non-ok verdict. */
  reason?: string;
  /** Where clicking the tier goes (its Knowledge view, or the Library). */
  href: string;
  ariaLabel: string;
}

export interface TierFlowConnector {
  label: 'Compact' | 'Publish';
  tone?: FlowTone;
}

export interface TierAttention {
  level: Level;
  verdict: 'behind' | 'stalled';
  tone: 'warning' | 'danger';
  /** "Guide updates delayed · Last run 12h ago" */
  title: string;
  /** The server's reason sentence. */
  detail: string;
  actionLabel: string;
  actionHref: string;
}

export interface TierFlowModel {
  items: TierFlowItem[];
  connectors: TierFlowConnector[];
  attention: TierAttention | null;
  dot: 'warning' | 'danger' | null;
}

const TIER_LABEL: Record<Level, string> = { L0: 'Run notes', L1: 'Patterns', L2: 'Guides & findings' };
/** What a delayed inbound edge means to a reader. */
const TIER_UPDATES: Record<Level, string> = { L0: 'Run-note intake', L1: 'Pattern updates', L2: 'Guide updates' };
const LEVELS: readonly Level[] = ['L0', 'L1', 'L2'];

const LEGACY_STATE: Record<LevelHealth['status'], TierHealthState> = { healthy: 'ok', behind: 'behind', stalled: 'stalled' };

/** The server's verdict for one tier: its own `health`, else the legacy
 *  `health[]` row, else unknown. */
export function tierHealth(tier: TierLevel | undefined, legacy: LevelHealth[] = [], level?: Level): TierHealth | null {
  if (tier?.health) return tier.health;
  const lv = tier?.level ?? level;
  const old = legacy.find((h) => h.level === lv);
  if (!old) return null;
  return { state: LEGACY_STATE[old.status], reason: old.reason, lagSeconds: tier?.lagSeconds ?? 0 };
}

export function tierCount(tier: TierLevel | undefined): number | null {
  if (!tier) return null;
  if (typeof tier.count === 'number') return tier.count;
  if (typeof tier.items === 'number') return tier.items;
  return null;
}

/** "just now" · "50m ago" · "12h ago" · "3d ago"; '' when unparseable. */
export function agoLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '';
  const then = parsePgTimestamp(iso);
  if (then === null) return '';
  const mins = Math.floor((nowMs - then.getTime()) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const SEVERITY: Record<TierVerdict, number> = { unknown: 0, ok: 0, behind: 1, stalled: 2 };

function statusFor(tier: TierLevel | undefined, health: TierHealth | null): TierFlowItem['status'] {
  if (health?.state === 'stalled') return { label: 'Stalled', tone: 'danger' };
  if (health?.state === 'behind') {
    return { label: health.lagSeconds > 0 ? `${lagLabel(health.lagSeconds)} behind` : 'Behind', tone: 'warning' };
  }
  if (!tier) return undefined;
  if (tier.level === 'L0' && typeof tier.writers === 'number' && tier.writers > 0) {
    return { label: `${tier.writers} writing`, tone: 'info' };
  }
  if (typeof tier.backlog === 'number' && tier.backlog > 0) {
    return { label: `${tier.backlog} waiting`, tone: 'neutral' };
  }
  return undefined;
}

function toneFor(verdict: TierVerdict): FlowTone | undefined {
  if (verdict === 'stalled') return 'danger';
  if (verdict === 'behind') return 'warning';
  return undefined;
}

/**
 * The strip, its connectors, the Activity status line and the tab dot.
 *
 * `libraryLinked` is how many guides are linked to a Library asset; null when
 * the caller could not read it.
 */
export function tierFlowModel(
  levels: TierLevel[],
  libraryLinked: number | null,
  opts: { legacyHealth?: LevelHealth[]; nowMs?: number } = {},
): TierFlowModel {
  const nowMs = opts.nowMs ?? Date.now();
  const byLevel = new Map(levels.map((l) => [l.level, l]));

  const items: TierFlowItem[] = LEVELS.map((lv) => {
    const tier = byLevel.get(lv);
    const health = tierHealth(tier, opts.legacyHealth, lv);
    const verdict: TierVerdict = health?.state ?? 'unknown';
    const value = tierCount(tier);
    const status = statusFor(tier, health);
    return {
      id: lv,
      label: TIER_LABEL[lv],
      level: lv,
      value,
      status,
      verdict,
      reason: health && health.state !== 'ok' ? health.reason : undefined,
      href: knowledgeHref({ view: viewForLevel(lv) }),
      ariaLabel: [
        `${lv} ${TIER_LABEL[lv]}`,
        value == null ? 'count unknown' : `${value} items`,
        status?.label,
      ].filter(Boolean).join(', '),
    };
  });
  items.push({
    id: 'library',
    label: 'Library',
    level: null,
    value: libraryLinked,
    status: libraryLinked == null ? undefined : { label: 'linked', tone: 'neutral' },
    verdict: 'unknown',
    href: '/iq/library',
    ariaLabel: libraryLinked == null ? 'Library, linked count unknown' : `Library, ${libraryLinked} linked`,
  });

  // An edge's health is its destination tier's inbound verdict.
  const connectors: TierFlowConnector[] = [
    { label: 'Compact', tone: toneFor(items[1].verdict) },
    { label: 'Compact', tone: toneFor(items[2].verdict) },
    { label: 'Publish' },
  ];

  const attention = attentionFor(levels, opts.legacyHealth ?? [], nowMs);
  return { items, connectors, attention, dot: attention ? attention.tone : null };
}

/**
 * The single most important problem: the most severe verdict (stalled over
 * behind), ties broken by the larger lag. null when every tier is ok or
 * unknown.
 */
export function attentionFor(levels: TierLevel[], legacyHealth: LevelHealth[] = [], nowMs: number = Date.now()): TierAttention | null {
  let worst: { tier: TierLevel | undefined; level: Level; health: TierHealth } | null = null;
  for (const lv of LEVELS) {
    const tier = levels.find((l) => l.level === lv);
    const health = tierHealth(tier, legacyHealth, lv);
    if (!health || SEVERITY[health.state] === 0) continue;
    if (!worst
      || SEVERITY[health.state] > SEVERITY[worst.health.state]
      || (SEVERITY[health.state] === SEVERITY[worst.health.state] && health.lagSeconds > worst.health.lagSeconds)) {
      worst = { tier, level: lv, health };
    }
  }
  if (!worst) return null;
  const verdict = worst.health.state as 'behind' | 'stalled';
  const ago = agoLabel(worst.tier?.lastCompletedAt, nowMs);
  const lastRun = worst.level === 'L0'
    ? null
    : ago ? `Last run ${ago}` : 'No completed run yet';
  const headline = `${TIER_UPDATES[worst.level]} ${verdict === 'stalled' ? 'stalled' : 'delayed'}`;
  return {
    level: worst.level,
    verdict,
    tone: verdict === 'stalled' ? 'danger' : 'warning',
    title: [headline, lastRun].filter(Boolean).join(' · '),
    detail: worst.health.reason,
    actionLabel: 'View runs',
    actionHref: activityHref({ view: 'runs', level: worst.level === 'L0' ? null : worst.level }),
  };
}

/** The Activity tab's dot: danger when any tier is stalled, warning when any
 *  is behind, null otherwise (including when no verdicts are known). */
export function activityDot(levels: TierLevel[], legacyHealth: LevelHealth[] = []): 'warning' | 'danger' | null {
  let sev = 0;
  for (const lv of LEVELS) {
    const h = tierHealth(levels.find((l) => l.level === lv), legacyHealth, lv);
    if (h) sev = Math.max(sev, SEVERITY[h.state]);
  }
  return sev === 2 ? 'danger' : sev === 1 ? 'warning' : null;
}
