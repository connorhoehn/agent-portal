// What a model a machine announced is actually good for.
//
// A paired machine self-reports the models it can run, and the fleet table
// printed them as bare chips: `claude-sonnet-5`, `llama3.1:8b`. That tells you
// a string, not a capability. The question someone actually has in front of
// this table is "can I give this machine the hard job, or only the small one?",
// and nothing on the page answered it.
//
// So: every announced id resolves to a TIER, and a tier says what size of task
// it takes. Matching is on model FAMILY, not exact version — ids arrive in at
// least three spellings for the same model (`claude-sonnet-5`,
// `us.anthropic.claude-sonnet-5`, `anthropic.claude-sonnet-5-v1:0`), and a new
// point release should not silently drop to "unknown".

export type ModelTier = 'deep' | 'balanced' | 'quick' | 'local' | 'unknown';

export interface ModelCapability {
  /** The id exactly as the machine announced it. */
  id: string;
  /** Short display name — `Sonnet 5`, `llama3.1:8b`. */
  label: string;
  tier: ModelTier;
}

export interface TierInfo {
  tier: ModelTier;
  /** One or two words, for a chip. */
  name: string;
  /** What size of task this tier takes on. Written for someone assigning work. */
  takesOn: string;
  /** Ordering for "best model on this machine". Higher handles more. */
  rank: number;
}

/**
 * The tiers, in the order they should be offered.
 *
 * `local` sits apart rather than on the ladder: an on-device model's ceiling
 * depends on its parameter count and quantisation, which the announced id only
 * hints at. Calling it "quick" would be a guess stated as a fact.
 */
export const TIERS: Record<ModelTier, TierInfo> = {
  deep: {
    tier: 'deep',
    name: 'Deep',
    takesOn: 'Long multi-step work, tricky reasoning, big refactors. Slowest and dearest — worth it when the task would otherwise need a person.',
    rank: 3,
  },
  balanced: {
    tier: 'balanced',
    name: 'Balanced',
    takesOn: 'Most real work: writing and reviewing code, multi-tool runs, research with a clear goal.',
    rank: 2,
  },
  quick: {
    tier: 'quick',
    name: 'Quick',
    takesOn: 'Short, well-defined jobs — a summary, a rename, a lint pass, a single file edit. Cheapest and fastest.',
    rank: 1,
  },
  local: {
    tier: 'local',
    name: 'On-device',
    takesOn: 'Runs on the machine itself, so it needs no key and leaks nothing. What it can handle depends on its size — treat it as quick work until you have watched it do more.',
    rank: 1,
  },
  unknown: {
    tier: 'unknown',
    name: 'Unrecognised',
    takesOn: 'Not a model this console knows. It may run fine — nothing here can say what it is suited to.',
    rank: 0,
  },
};

/** Work that suits a tier, phrased as something you would actually ask for. */
export const TIER_IDEAS: Record<ModelTier, string[]> = {
  deep: [
    'A migration or refactor that spans several files and needs the whole shape held at once',
    'Working through a bug whose cause is not yet known',
    'Reviewing a large change for design problems rather than style',
  ],
  balanced: [
    'Implementing a work item end to end, tests included',
    'Bringing a dependency up to date and fixing what breaks',
    'Turning an issue thread into a concrete plan with file-level steps',
  ],
  quick: [
    'Summarising a long thread or a run log',
    'A rename or a mechanical edit across a handful of files',
    'Triaging new issues into labels and priorities',
  ],
  local: [
    'Anything the data should not leave the machine for',
    'Bulk classification or summarising over local files',
    'A first pass that a stronger model reviews afterwards',
  ],
  unknown: [
    'Start with something small and reversible until you have watched it work',
  ],
};

/** Families that run on the machine rather than behind an API. */
const LOCAL_FAMILIES = [
  'llama',
  'mistral',
  'mixtral',
  'qwen',
  'gemma',
  'phi',
  'deepseek',
  'codellama',
  'starcoder',
];

/** Strip provider prefixes and version suffixes down to something matchable. */
function normalise(id: string): string {
  return id
    .toLowerCase()
    // Bedrock inference profiles: `us.anthropic.claude-…`, `eu.anthropic.…`
    .replace(/^[a-z]{2}\.anthropic\./, '')
    .replace(/^anthropic\./, '')
    // Bedrock version suffix: `-v1:0`
    .replace(/-v\d+:\d+$/, '');
}

/**
 * The tier an announced model id belongs to.
 *
 * Anthropic families first, because an id containing both (`claude` and a local
 * family name) is a Claude model running through some wrapper, not a local one.
 */
export function tierFor(id: string): ModelTier {
  const n = normalise(id);
  if (n.includes('opus')) return 'deep';
  if (n.includes('sonnet') || n.includes('fable')) return 'balanced';
  if (n.includes('haiku')) return 'quick';
  if (LOCAL_FAMILIES.some((f) => n.includes(f))) return 'local';
  return 'unknown';
}

/** A readable name for an announced id. */
export function labelFor(id: string): string {
  const n = normalise(id);
  const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => n.includes(f));
  if (family) {
    // Keep the version so `Sonnet 5` and `Sonnet 4` stay distinguishable.
    const version = /(\d+(?:[.-]\d+)?)/.exec(n.slice(n.indexOf(family)))?.[1];
    const pretty = family.charAt(0).toUpperCase() + family.slice(1);
    return version ? `${pretty} ${version.replace('-', '.')}` : pretty;
  }
  // Local models read best as announced — `llama3.1:8b` carries its own size.
  return id;
}

/** Resolve one announced id. */
export function capabilityFor(id: string): ModelCapability {
  return { id, label: labelFor(id), tier: tierFor(id) };
}

/** Resolve a machine's announced list, de-duplicated, strongest first. */
export function capabilitiesFor(ids: readonly string[]): ModelCapability[] {
  const seen = new Set<string>();
  const out: ModelCapability[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(capabilityFor(id));
  }
  return out.sort((a, b) => TIERS[b.tier].rank - TIERS[a.tier].rank);
}

/**
 * The most capable tier a machine can run, or null when it announced nothing.
 *
 * Drives "what can I give this machine": the ceiling is what matters when
 * deciding whether the hard job can go here.
 */
export function bestTier(ids: readonly string[]): ModelTier | null {
  const caps = capabilitiesFor(ids);
  if (caps.length === 0) return null;
  return caps[0].tier;
}
