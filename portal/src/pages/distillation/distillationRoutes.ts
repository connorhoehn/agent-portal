// URL state for the redesigned Distillation module (Knowledge / Review /
// Activity) and the mapping from every pre-redesign route to it.
// docs/distillation-redesign-spec.md §1 is the contract.
//
// Pure: no React, no router. The pages parse `location.search` through the
// `parse*` functions and build every link through the `*Href` functions, so a
// param name is spelled in exactly one place. The redirect components in
// App.tsx call `migrateDistillationUrl` and nothing else.
//
// Serialisation omits defaults (`view=guides`, `sourceView=list`,
// `tab=pending`, `view=runs`) so the canonical URL for a surface is short and
// two links to the same state compare equal.
//
// Filter names beyond the spec's list: the Knowledge filter popover carries
// type/kind and lifecycle, which the old Tiers (`kind`) and Artifacts
// (`type`, `status`) pages kept in the URL. They migrate to `kind` and
// `lifecycle`; Activity keeps the old Compactions `level`/`status` filters.

export const DISTILLATION_BASE = '/iq/distillation';

export type DistillationTab = 'knowledge' | 'review' | 'activity';
export const DISTILLATION_TABS: readonly DistillationTab[] = ['knowledge', 'review', 'activity'];

export type KnowledgeView = 'guides' | 'patterns' | 'notes';
export type SourceView = 'list' | 'graph';
export type ReviewTab = 'pending' | 'decided';
export type ActivityView = 'runs' | 'graph';
export type TierLevel = 'L0' | 'L1' | 'L2';

export interface KnowledgeState {
  view: KnowledgeView;
  item: string | null;
  /** 'sources' opens the Sources inspector; null keeps it closed. */
  panel: 'sources' | null;
  sourceView: SourceView;
  repo: string | null;
  initiative: string | null;
  q: string | null;
  /** Artifact type (guides) or observation kind (notes/patterns). */
  kind: string | null;
  /** Artifact lifecycle: draft | published | retired. */
  lifecycle: string | null;
}

export interface ReviewState {
  tab: ReviewTab;
  sample: string | null;
  panel: 'sources' | null;
  sourceView: SourceView;
  q: string | null;
  /** The module header's repository scope, carried across tabs. */
  repo: string | null;
}

export interface ActivityState {
  view: ActivityView;
  run: string | null;
  repo: string | null;
  /** Compaction target tier — 'L1' (L0→L1) or 'L2' (L1→L2). */
  level: 'L1' | 'L2' | null;
  status: string | null;
}

type SearchInput = string | URLSearchParams;

function params(search: SearchInput): URLSearchParams {
  return typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
}

/** A trimmed, non-empty param or null. `?repo=` is "no repo filter". */
function str(p: URLSearchParams, key: string): string | null {
  const v = p.get(key);
  if (v == null) return null;
  const t = v.trim();
  return t === '' || t === 'all' ? null : t;
}

function oneOf<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return v != null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const KNOWLEDGE_VIEWS: readonly KnowledgeView[] = ['guides', 'patterns', 'notes'];
const SOURCE_VIEWS: readonly SourceView[] = ['list', 'graph'];
const REVIEW_TABS: readonly ReviewTab[] = ['pending', 'decided'];
const ACTIVITY_VIEWS: readonly ActivityView[] = ['runs', 'graph'];

// ── Tier ↔ Knowledge view ────────────────────────────────────────────────

const LEVEL_VIEW: Record<TierLevel, KnowledgeView> = { L0: 'notes', L1: 'patterns', L2: 'guides' };
const VIEW_LEVEL: Record<KnowledgeView, TierLevel> = { notes: 'L0', patterns: 'L1', guides: 'L2' };

export function viewForLevel(level: TierLevel): KnowledgeView { return LEVEL_VIEW[level]; }
export function levelForView(view: KnowledgeView): TierLevel { return VIEW_LEVEL[view]; }

// ── Parse ────────────────────────────────────────────────────────────────

export function parseKnowledge(search: SearchInput): KnowledgeState {
  const p = params(search);
  return {
    view: oneOf(str(p, 'view'), KNOWLEDGE_VIEWS, 'guides'),
    item: str(p, 'item'),
    panel: str(p, 'panel') === 'sources' ? 'sources' : null,
    sourceView: oneOf(str(p, 'sourceView'), SOURCE_VIEWS, 'list'),
    repo: str(p, 'repo'),
    initiative: str(p, 'initiative'),
    q: str(p, 'q'),
    kind: str(p, 'kind'),
    lifecycle: str(p, 'lifecycle'),
  };
}

export function parseReview(search: SearchInput): ReviewState {
  const p = params(search);
  return {
    tab: oneOf(str(p, 'tab'), REVIEW_TABS, 'pending'),
    sample: str(p, 'sample'),
    panel: str(p, 'panel') === 'sources' ? 'sources' : null,
    sourceView: oneOf(str(p, 'sourceView'), SOURCE_VIEWS, 'list'),
    q: str(p, 'q'),
    repo: str(p, 'repo'),
  };
}

export function parseActivity(search: SearchInput): ActivityState {
  const p = params(search);
  const level = str(p, 'level');
  return {
    view: oneOf(str(p, 'view'), ACTIVITY_VIEWS, 'runs'),
    run: str(p, 'run'),
    repo: str(p, 'repo'),
    level: level === 'L1' || level === 'L2' ? level : null,
    status: str(p, 'status'),
  };
}

// ── Serialise ────────────────────────────────────────────────────────────

function build(path: string, entries: Array<[string, string | null | undefined]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of entries) if (v != null && v !== '') p.set(k, v);
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

export function knowledgeHref(state: Partial<KnowledgeState> = {}): string {
  return build(`${DISTILLATION_BASE}/knowledge`, [
    ['view', state.view && state.view !== 'guides' ? state.view : null],
    ['item', state.item],
    ['panel', state.panel],
    // sourceView only means something while the inspector is open.
    ['sourceView', state.panel === 'sources' && state.sourceView === 'graph' ? 'graph' : null],
    ['repo', state.repo],
    ['initiative', state.initiative],
    ['kind', state.kind],
    ['lifecycle', state.lifecycle],
    ['q', state.q],
  ]);
}

export function reviewHref(state: Partial<ReviewState> = {}): string {
  return build(`${DISTILLATION_BASE}/review`, [
    ['tab', state.tab === 'decided' ? 'decided' : null],
    ['sample', state.sample],
    ['panel', state.panel],
    ['sourceView', state.panel === 'sources' && state.sourceView === 'graph' ? 'graph' : null],
    ['q', state.q],
    ['repo', state.repo],
  ]);
}

export function activityHref(state: Partial<ActivityState> = {}): string {
  return build(`${DISTILLATION_BASE}/activity`, [
    ['view', state.view === 'graph' ? 'graph' : null],
    ['run', state.run],
    ['repo', state.repo],
    ['level', state.level],
    ['status', state.status],
  ]);
}

/** Link to one record in Knowledge, in the view its tier lives in. */
export function knowledgeItemHref(id: string, level: TierLevel = 'L2', extra: Partial<KnowledgeState> = {}): string {
  return knowledgeHref({ ...extra, view: viewForLevel(level), item: id });
}

/** A tab's landing URL carrying only the header's repository scope — what a
 *  tab click navigates to, so switching tabs keeps the repo selector. */
export function tabHref(tab: DistillationTab, repo: string | null): string {
  if (tab === 'knowledge') return knowledgeHref({ repo });
  if (tab === 'review') return reviewHref({ repo });
  return activityHref({ repo });
}

/** Which of the three tabs a pathname is on, or null off-module. */
export function tabForPath(pathname: string): DistillationTab | null {
  const seg = pathname.replace(/\/+$/, '').split('/')[3];
  return (DISTILLATION_TABS as readonly string[]).includes(seg ?? '') ? (seg as DistillationTab) : null;
}

// ── Migration from the pre-redesign routes (spec §1 "Migration") ─────────

/**
 * The new URL for a pre-redesign Distillation URL, or null when `pathname` is
 * not one (already a new route, or not under /iq/distillation at all).
 *
 * `/review` is both an old and a new route: its old param (`tab`) is a subset
 * of the new one, so it is never migrated — it returns null and renders.
 */
export function migrateDistillationUrl(pathname: string, search: SearchInput = ''): string | null {
  const path = pathname.replace(/\/+$/, '');
  if (path !== DISTILLATION_BASE && !path.startsWith(`${DISTILLATION_BASE}/`)) return null;
  const sub = path.slice(DISTILLATION_BASE.length + 1);
  const p = params(search);

  switch (sub) {
    case '':
    case 'overview':
      return knowledgeHref({ view: 'guides' });

    case 'tiers': {
      const level = oneOf<TierLevel>(str(p, 'level'), ['L0', 'L1', 'L2'], 'L0');
      return knowledgeHref({
        view: viewForLevel(level),
        repo: str(p, 'repo'),
        initiative: str(p, 'initiative'),
        // The old page only honoured `kind` on L0; carry it only there.
        kind: level === 'L0' ? str(p, 'kind') : null,
        q: str(p, 'q'),
      });
    }

    case 'artifacts':
      return knowledgeHref({
        view: 'guides',
        item: str(p, 'open'),
        kind: str(p, 'type'),
        lifecycle: str(p, 'status'),
        q: str(p, 'q'),
      });

    case 'lineage': {
      const focus = str(p, 'focus');
      // No focus: open the Sources inspector on Graph with nothing selected —
      // the page asks the reader to choose an item.
      return knowledgeHref({ view: 'guides', item: focus, panel: 'sources', sourceView: 'graph' });
    }

    case 'compactions': {
      const level = str(p, 'level');
      return activityHref({
        view: str(p, 'view') === 'graph' ? 'graph' : 'runs',
        level: level === 'L1' || level === 'L2' ? level : null,
        status: str(p, 'status'),
        run: str(p, 'run'),
        repo: str(p, 'repo'),
      });
    }

    default:
      return null;
  }
}

/** Every legacy sub-path App.tsx must register a redirect for. */
export const LEGACY_DISTILLATION_PATHS = ['overview', 'tiers', 'artifacts', 'lineage', 'compactions'] as const;
