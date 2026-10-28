// SDLC governance — the gate engine.
//
// An agent changes code in a workspace, and until now that change simply sat
// there: nothing reviewed it, nothing approved it, nothing delivered it. That
// is fine for a toy and unacceptable for anything an organisation would run —
// an agent editing auth code, touching infrastructure, or rewriting a hundred
// files should not be trusted merely because an agent did it.
//
// This is the policy layer that decides what happens to a candidate change.
// It is deliberately pure — no database, no network, no clock — so the rules
// that govern whether agent-written code can ship are testable in isolation
// and cannot behave one way in a test and another in production.
//
// The model mirrors the graph-proposals pattern that already governs graph
// writes ("propose → approve → apply"), extended to code: a change is
// evaluated against a set of policies, each policy yields a gate outcome, and
// the outcomes aggregate into a single decision about the change.

export type PolicyKind =
  /** Always require an independent agent review; the verdict drives the gate. */
  | 'require_review'
  /** Touching any of these path globs is sensitive. */
  | 'protected_paths'
  /** A change over this many files is large enough to warrant a second look. */
  | 'max_files'
  /** Only these models may author a change that ships. */
  | 'model_allowlist'
  /** A change whose run cost more than this many dollars needs a human. */
  | 'max_cost';

/** What a triggered policy does — never silently; always one of these. */
export type PolicyAction = 'require_approval' | 'block';

export interface SdlcPolicy {
  id: string;
  name: string;
  enabled: boolean;
  kind: PolicyKind;
  /** Shape depends on kind — see evaluatePolicy. */
  config: Record<string, unknown>;
  action: PolicyAction;
}

/** A reviewer's verdict on the change, when a review has been done. */
export type ReviewVerdict = 'approve' | 'request_changes' | 'reject';

/** Facts about a candidate change, all a policy is allowed to see. */
export interface ChangeFacts {
  /** Repo-relative paths the change touches. */
  files: string[];
  /** Model that authored the run, if known. */
  model: string | null;
  /** The independent review verdict, once one exists. */
  reviewVerdict: ReviewVerdict | null;
  /** Dollar cost of the run that authored the change, when recorded. */
  costUsd: number | null;
}

export type GateOutcome = 'pass' | 'requires_approval' | 'block';

export interface GateResult {
  /** The policy row's id, or null for a synthetic gate not backed by a row. */
  policyId: string | null;
  policyName: string;
  kind: PolicyKind;
  outcome: GateOutcome;
  /** One plain sentence, safe to show verbatim. */
  detail: string;
}

/** The aggregate decision — what the change becomes after all gates run. */
export type ChangeDecision = 'approved' | 'needs_approval' | 'changes_requested' | 'blocked';

export interface Evaluation {
  gates: GateResult[];
  decision: ChangeDecision;
  /** True when nothing stands between this change and delivery. */
  autoApproved: boolean;
}

// ─── Glob matching ──────────────────────────────────────────────────────────

/**
 * Minimal glob → regex, supporting `*`, `**`, and `?`.
 *
 * Hand-rolled rather than pulled from a dependency because the set of features
 * a protected-paths rule needs is tiny, and a governance decision should not
 * hinge on the surprising corners of a general-purpose glob library. `**`
 * crosses directory separators; `*` does not.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` or `**` — any number of path segments, slashes included.
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c as string)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** A leading "./" or "/" is noise for matching; normalise it away. */
function normalizePath(p: string): string {
  return p.replace(/^\.?\//, '');
}

function matchesAny(path: string, globs: string[]): boolean {
  const norm = normalizePath(path);
  return globs.some((g) => globToRegExp(normalizePath(g)).test(norm));
}

// ─── Per-policy evaluation ──────────────────────────────────────────────────

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Evaluate one policy against the change. Returns null when the policy simply
 * does not apply — a policy that does not fire is not a gate, and cluttering
 * the result with a dozen "pass, not relevant" rows would bury the ones that
 * matter.
 */
export function evaluatePolicy(policy: SdlcPolicy, facts: ChangeFacts): GateResult | null {
  if (!policy.enabled) return null;
  const base = { policyId: policy.id, policyName: policy.name, kind: policy.kind };

  switch (policy.kind) {
    case 'require_review': {
      // Until a review exists this gate is pending, not passing — a change
      // must not slip past review by being evaluated before the reviewer runs.
      if (facts.reviewVerdict === null) {
        return { ...base, outcome: 'requires_approval', detail: 'Awaiting an independent review.' };
      }
      if (facts.reviewVerdict === 'reject') {
        return { ...base, outcome: 'block', detail: 'The reviewer rejected this change.' };
      }
      if (facts.reviewVerdict === 'request_changes') {
        // Not a hard block: the author can revise. Modelled as a block here and
        // mapped to `changes_requested` in the aggregate, which is a distinct,
        // recoverable state.
        return { ...base, outcome: 'block', detail: 'The reviewer requested changes.' };
      }
      return { ...base, outcome: 'pass', detail: 'The reviewer approved this change.' };
    }

    case 'protected_paths': {
      const globs = stringList(policy.config['globs']);
      const hit = facts.files.filter((f) => matchesAny(f, globs));
      if (hit.length === 0) return null;
      const detail = `Touches protected path${hit.length > 1 ? 's' : ''}: ${hit.slice(0, 3).join(', ')}${hit.length > 3 ? ` +${hit.length - 3}` : ''}.`;
      return { ...base, outcome: policy.action === 'block' ? 'block' : 'requires_approval', detail };
    }

    case 'max_files': {
      const max = Number(policy.config['max'] ?? 0);
      if (!Number.isFinite(max) || max <= 0 || facts.files.length <= max) return null;
      return {
        ...base,
        outcome: policy.action === 'block' ? 'block' : 'requires_approval',
        detail: `Changes ${facts.files.length} files; the limit is ${max}.`,
      };
    }

    case 'model_allowlist': {
      const allowed = stringList(policy.config['models']);
      if (allowed.length === 0) return null;
      // An unknown model is treated as not-allowed: the safe reading of "we do
      // not know what wrote this" is to gate it, not wave it through.
      const model = facts.model ?? '(unknown)';
      if (allowed.includes(model)) return null;
      return {
        ...base,
        outcome: policy.action === 'block' ? 'block' : 'requires_approval',
        detail: `Authored by ${model}, which is not on the allowlist.`,
      };
    }

    case 'max_cost': {
      const maxUsd = Number(policy.config['maxUsd'] ?? 0);
      if (!Number.isFinite(maxUsd) || maxUsd <= 0) return null;
      // No recorded cost means this policy has no fact to judge — a spend gate
      // cannot fire on a number that does not exist. Fail-open is correct
      // *here* because it is not open overall: the require_review policy still
      // gates the change, so a run whose cost was never recorded is reviewed
      // like any other rather than stuck behind a gate nobody can satisfy.
      if (facts.costUsd == null) return null;
      if (facts.costUsd <= maxUsd) return null;
      return {
        ...base,
        outcome: policy.action === 'block' ? 'block' : 'requires_approval',
        detail: `The run cost $${facts.costUsd.toFixed(2)}; the limit is $${maxUsd.toFixed(2)}.`,
      };
    }

    default:
      return null;
  }
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/**
 * Evaluate all policies and decide what the change becomes.
 *
 * The aggregate takes the strictest outcome, in a fixed order of severity so
 * the result is deterministic: any block wins, then a requested-change (from a
 * review), then a required approval, and only a change that triggers nothing —
 * or only passes — is auto-approved. Auto-approval is the exception here, not
 * the default, which is the whole point of a governance layer.
 */
export function evaluate(policies: SdlcPolicy[], facts: ChangeFacts): Evaluation {
  const gates = policies
    .map((p) => evaluatePolicy(p, facts))
    .filter((g): g is GateResult => g !== null);

  // A hard block from a *policy* (protected_paths, model_allowlist, max_files
  // with action:block) is terminal and must win over everything — including a
  // reviewer that happens to also ask for changes. Without this, a change a
  // policy forbade could be relabelled `changes_requested`, which a human is
  // allowed to approve: the policy block would be silently downgraded to a
  // recoverable, shippable state. A policy block is never recoverable.
  const policyBlock = gates.some((g) => g.outcome === 'block' && g.kind !== 'require_review');

  // A review that requested changes is a distinct decision from a hard block,
  // so it is detected before collapsing everything else to blocked/approval.
  // Keyed off the actual verdict, not the gate's wording: matching on detail
  // text would make the aggregate silently wrong the moment that sentence is
  // reworded. It still requires the review gate to be enabled and firing.
  const reviewChangesRequested = facts.reviewVerdict === 'request_changes'
    && gates.some((g) => g.kind === 'require_review' && g.outcome === 'block');

  const anyBlock = gates.some((g) => g.outcome === 'block');
  const anyApproval = gates.some((g) => g.outcome === 'requires_approval');

  let decision: ChangeDecision;
  if (policyBlock) decision = 'blocked';
  else if (reviewChangesRequested) decision = 'changes_requested';
  else if (anyBlock) decision = 'blocked';
  else if (anyApproval) decision = 'needs_approval';
  else decision = 'approved';

  return { gates, decision, autoApproved: decision === 'approved' };
}

// ─── Governance code ────────────────────────────────────────────────────────

/**
 * The files that ARE the governance: the gate engine, its schema, the Cedar
 * seeds and the authorization code (DE-43 §6, DE-46). A change touching one
 * needs a human like any sensitive path, and approving it is reserved to the
 * roles in SDLC_GOVERNANCE_APPROVER_ROLES (providers/sdlc.ts decideChange).
 */
export const GOVERNANCE_PATH_GLOBS: readonly string[] = [
  '**/sdlc-policy*', '**/sdlc*.sql', '**/seeds/roles/**', '**/*.cedar', '**/authz*',
];

/** The changed files that touch governance code. */
export function governancePathsTouched(files: readonly string[]): string[] {
  return files.filter((f) => matchesAny(f, [...GOVERNANCE_PATH_GLOBS]));
}

// ─── Policy sets: validation and loosening (DE-43/DE-46) ───────────────────

const KINDS: readonly PolicyKind[] = ['require_review', 'protected_paths', 'max_files', 'model_allowlist', 'max_cost'];

/** Whether a value names a policy kind the engine knows. */
export function isPolicyKind(v: unknown): v is PolicyKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/**
 * Normalise one policy of a submitted set, or say why it cannot be one.
 * `id` is the policy's stable key across versions; diffs line up on it.
 */
export function normalizePolicy(raw: unknown): SdlcPolicy | string {
  if (!raw || typeof raw !== 'object') return 'each policy must be an object';
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'].trim() : typeof r['key'] === 'string' ? r['key'].trim() : '';
  if (!id) return 'each policy needs a stable id';
  const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
  if (!name) return `policy ${id} needs a name`;
  if (!isPolicyKind(r['kind'])) return `policy ${id}: kind must be one of: ${KINDS.join(', ')}`;
  const config = r['config'] && typeof r['config'] === 'object' && !Array.isArray(r['config'])
    ? { ...(r['config'] as Record<string, unknown>) } : {};
  return {
    id, name, enabled: r['enabled'] !== false, kind: r['kind'],
    config, action: r['action'] === 'block' ? 'block' : 'require_approval',
  };
}

/**
 * Why a whole set cannot be stored, or null. Ids must be unique, and the set
 * must keep a require_review policy: the independent review is the one gate
 * every change passes through, so it cannot be deleted while it is the only
 * one (it can still be disabled, which is a loosening edit).
 */
export function policySetError(policies: readonly SdlcPolicy[]): string | null {
  const ids = new Set<string>();
  for (const p of policies) {
    if (ids.has(p.id)) return `duplicate policy id ${p.id}`;
    ids.add(p.id);
  }
  if (!policies.some((p) => p.kind === 'require_review')) {
    return 'the independent-review policy cannot be removed; disable it instead (a loosening edit)';
  }
  return null;
}

/** How strict an action is: block outranks require_approval. */
const actionRank = (a: PolicyAction): number => (a === 'block' ? 2 : 1);
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

/**
 * Every way `after` is looser than `before`, as sentences; empty when it is
 * not looser anywhere. Loosening (DE-43 §4): a policy that was enabled is
 * disabled or gone, `block` became `require_approval`, a limit was raised or
 * cleared, a protected glob was removed, a model was allowed, or a policy
 * changed kind. Policies only in `after` are additions, never loosening.
 *
 * Read against the model allowlist the spec's wording "removes a model" would
 * be backwards: removing a model from an allowlist tightens it. Adding one,
 * or emptying the list (which switches the gate off), loosens it.
 */
export function looseningChanges(before: readonly SdlcPolicy[], after: readonly SdlcPolicy[]): string[] {
  const out: string[] = [];
  const next = new Map(after.map((p) => [p.id, p]));
  for (const b of before) {
    if (!b.enabled) continue;
    const a = next.get(b.id);
    if (!a) { out.push(`removes "${b.name}"`); continue; }
    if (!a.enabled) { out.push(`disables "${b.name}"`); continue; }
    if (a.kind !== b.kind) { out.push(`changes the kind of "${b.name}"`); continue; }
    if (actionRank(a.action) < actionRank(b.action)) out.push(`downgrades "${b.name}" from block to require_approval`);
    switch (b.kind) {
      case 'max_files': {
        const was = num(b.config['max']); const now = num(a.config['max']);
        if (was > 0 && (now <= 0 || now > was)) out.push(`raises "${b.name}" from ${was} to ${now <= 0 ? 'no limit' : now}`);
        break;
      }
      case 'max_cost': {
        const was = num(b.config['maxUsd']); const now = num(a.config['maxUsd']);
        if (was > 0 && (now <= 0 || now > was)) out.push(`raises "${b.name}" from $${was} to ${now <= 0 ? 'no limit' : `$${now}`}`);
        break;
      }
      case 'protected_paths': {
        const kept = new Set(stringList(a.config['globs']));
        const gone = stringList(b.config['globs']).filter((g) => !kept.has(g));
        if (gone.length) out.push(`removes ${gone.length} protected path${gone.length > 1 ? 's' : ''} from "${b.name}" (${gone.slice(0, 3).join(', ')})`);
        break;
      }
      case 'model_allowlist': {
        const was = stringList(b.config['models']);
        const now = stringList(a.config['models']);
        if (was.length > 0 && now.length === 0) out.push(`empties the allowlist of "${b.name}"`);
        else if (was.length > 0) {
          const added = now.filter((m) => !was.includes(m));
          if (added.length) out.push(`allows ${added.join(', ')} in "${b.name}"`);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Insert or replace one policy (by id) in a set — the legacy POST /policies edit. */
export function withPolicy(set: readonly SdlcPolicy[], policy: SdlcPolicy): SdlcPolicy[] {
  const i = set.findIndex((p) => p.id === policy.id);
  if (i < 0) return [...set, policy];
  const out = [...set];
  out[i] = policy;
  return out;
}

/** The set without one policy — the legacy DELETE /policies/:id edit. */
export function withoutPolicy(set: readonly SdlcPolicy[], id: string): SdlcPolicy[] {
  return set.filter((p) => p.id !== id);
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * The policies a sensible environment starts with.
 *
 * Chosen so the out-of-the-box behaviour is safe rather than permissive: every
 * change is reviewed, anything touching infrastructure, auth, CI, or the
 * governance rules themselves needs a human, and a sprawling change needs a
 * human. An operator can loosen these; they should have to choose to.
 */
export const DEFAULT_POLICIES: Omit<SdlcPolicy, 'id'>[] = [
  {
    name: 'Independent review required',
    enabled: true,
    kind: 'require_review',
    config: {},
    action: 'require_approval',
  },
  {
    name: 'Sensitive paths need a human',
    enabled: true,
    kind: 'protected_paths',
    config: {
      globs: [
        'infra/**', '**/auth/**', '**/*auth*', '.github/**',
        '**/Dockerfile', '**/*.tf', '**/secrets/**',
        // The governance rules themselves (DE-43/DE-46): until these were
        // here, the comment above was not true of any default glob.
        ...GOVERNANCE_PATH_GLOBS,
      ],
    },
    action: 'require_approval',
  },
  {
    name: 'Large changes need a human',
    enabled: true,
    kind: 'max_files',
    config: { max: 40 },
    action: 'require_approval',
  },
  {
    name: 'Expensive runs need a human',
    enabled: true,
    kind: 'max_cost',
    config: { maxUsd: 5 },
    action: 'require_approval',
  },
];
