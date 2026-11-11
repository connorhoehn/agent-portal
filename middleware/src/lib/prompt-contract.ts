// The prompt contract — what a library entry declares about its inputs, and
// how those inputs are rendered into the template.
//
// This module exists because the library previously stored NO type
// information: Prompt Studio guessed a variable's shape from its NAME
// (`reviewer` → a people picker, `summary` → a textarea), and the agent
// runtime never substituted anything at all — `prompt_source.py` handed the
// model a template with `{{…}}` still in it. So a parameterised prompt could
// be tested but never shipped.
//
// The contract fixes both, and carries the security boundary as data:
//
//   Every variable declares a SOURCE, and the source decides how the value
//   reaches the model. A `literal` or `caller` value is trusted enough to sit
//   inline with the instructions. A `retrieved` or `untrusted` value is NOT:
//   it is fenced into a labelled block, and any attempt to close that fence
//   from inside the value is defanged. That is the OWASP rule — never let
//   untrusted text share a channel with the instructions it could rewrite —
//   expressed as a property of the prompt rather than a habit of whoever
//   wrote it.
//
// Pure: no AWS, no Aurora, no React. Rendering and validation are testable in
// isolation, which is the point — this is the code that decides what a model
// is told.

// ─── Types ───────────────────────────────────────────────────────────────────

/** Who invokes this asset. Mirrors the MCP framing: model-driven, user-driven,
 *  or application-driven — the answer decides where it belongs and how much
 *  ceremony its release carries. */
export const PROMPT_KINDS = ['system', 'prompt', 'evaluator'] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

/** Blast radius. The tier — not a reviewer's memory — decides the gates. */
export const PROMPT_TIERS = ['sandbox', 'internal', 'endpoint'] as const;
export type PromptTier = (typeof PROMPT_TIERS)[number];

/** Where a value comes from, which is the same question as how much to trust it. */
export const VAR_SOURCES = ['literal', 'caller', 'retrieved', 'untrusted'] as const;
export type VarSource = (typeof VAR_SOURCES)[number];

export const VAR_TYPES = ['text', 'longtext', 'number', 'boolean', 'enum', 'person', 'skill'] as const;
export type VarType = (typeof VAR_TYPES)[number];

export interface PromptVariable {
  name: string;
  type: VarType;
  /** A required variable with no value is a hard render failure, never a
   *  silently empty slot — an empty slot is how a prompt quietly changes
   *  meaning in production. */
  required: boolean;
  source: VarSource;
  default?: string;
  description?: string;
  /** For `enum`: the allowed values. A value outside the list is refused. */
  options?: string[];
}

export interface PromptContract {
  kind: PromptKind;
  tier: PromptTier;
  variables: PromptVariable[];
  /** Guardrail bound to this asset. Required to deploy at the endpoint tier. */
  guardrailId?: string | null;
}

export const EMPTY_CONTRACT: PromptContract = {
  kind: 'prompt', tier: 'sandbox', variables: [], guardrailId: null,
};

/** Sources whose values are fenced rather than inlined. */
const FENCED: ReadonlySet<VarSource> = new Set<VarSource>(['retrieved', 'untrusted']);

export function isFenced(source: VarSource): boolean {
  return FENCED.has(source);
}

// ─── Parsing what a template actually asks for ───────────────────────────────

const VAR_PATTERN = /\{\{\s*([^}\s]+)\s*\}\}/g;

/** The variable names a template references, de-duplicated, in first-use order. */
export function templateVariables(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_PATTERN)) {
    const name = (m[1] ?? '').trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/**
 * Where the contract and the template disagree. Both directions matter:
 * a declared-but-unused variable is dead weight in the UI, while a
 * used-but-undeclared one is an UNTYPED HOLE — at render time it has no
 * source, so nothing can decide whether to fence it.
 */
export function contractDrift(template: string, contract: PromptContract): {
  undeclared: string[];
  unused: string[];
} {
  const used = new Set(templateVariables(template));
  const declared = new Set(contract.variables.map((v) => v.name));
  return {
    undeclared: [...used].filter((n) => !declared.has(n)),
    unused: [...declared].filter((n) => !used.has(n)),
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationIssue { name: string; problem: string }

/** Check supplied values against the contract. Returns every problem, not just
 *  the first — a caller fixing a form wants the whole list. */
export function validateValues(
  contract: PromptContract,
  values: Record<string, string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const v of contract.variables) {
    const raw = values[v.name];
    const supplied = raw != null && raw !== '';
    if (!supplied) {
      if (v.default != null) continue;
      if (v.required) issues.push({ name: v.name, problem: 'required, but no value was supplied' });
      continue;
    }
    if (v.type === 'number' && !Number.isFinite(Number(raw))) {
      issues.push({ name: v.name, problem: `expected a number, got "${truncate(raw)}"` });
    }
    if (v.type === 'boolean' && !['true', 'false'].includes(raw.toLowerCase())) {
      issues.push({ name: v.name, problem: `expected true or false, got "${truncate(raw)}"` });
    }
    if (v.type === 'enum') {
      const options = v.options ?? [];
      if (options.length === 0) {
        issues.push({ name: v.name, problem: 'declared as enum but lists no options' });
      } else if (!options.includes(raw)) {
        issues.push({ name: v.name, problem: `"${truncate(raw)}" is not one of: ${options.join(', ')}` });
      }
    }
  }
  return issues;
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Defang a fence from inside its own value.
 *
 * Without this the whole fence is theatre: a value containing
 * `</untrusted_input>` closes the block early and everything after it reads as
 * instructions again. Closing tags for our own fence tags are neutralised, and
 * so is the `{{…}}` syntax, so an injected value cannot smuggle in a
 * placeholder that a later pass would expand.
 */
export function defang(value: string): string {
  return value
    .replace(/<\s*\/\s*(untrusted_input|retrieved_content)\s*>/gi, '[/$1]')
    .replace(/\{\{/g, '{ {');
}

/** The fence a source renders into. */
function fenceTag(source: VarSource): string {
  return source === 'untrusted' ? 'untrusted_input' : 'retrieved_content';
}

export interface RenderResult {
  ok: boolean;
  text: string;
  issues: ValidationIssue[];
  /** Variables that were fenced — the trust boundary, reported so a caller
   *  (and a trace) can see it was applied. */
  fenced: string[];
}

/**
 * Render a template against its contract.
 *
 * Trusted values (`literal`, `caller`) substitute inline. Untrusted and
 * retrieved values are replaced by a labelled fence carrying the defanged
 * text, so the model can still read the content while the instruction channel
 * stays ours. A variable the template uses but the contract does not declare
 * is treated as untrusted — the safe default when nothing said otherwise.
 */
export function renderPrompt(
  template: string,
  contract: PromptContract,
  values: Record<string, string>,
): RenderResult {
  const issues = validateValues(contract, values);
  if (issues.length > 0) return { ok: false, text: template, issues, fenced: [] };

  const byName = new Map(contract.variables.map((v) => [v.name, v]));
  const fenced: string[] = [];

  const text = template.replace(VAR_PATTERN, (_match, rawName: string) => {
    const name = String(rawName).trim();
    const spec = byName.get(name);
    const value = values[name] ?? spec?.default ?? '';
    // Undeclared → untrusted. Nothing vouched for it, so it does not get to
    // sit next to the instructions.
    const source: VarSource = spec?.source ?? 'untrusted';
    if (!isFenced(source)) return value;
    fenced.push(name);
    const tag = fenceTag(source);
    return `<${tag} name="${name}">\n${defang(value)}\n</${tag}>`;
  });

  return { ok: true, text, issues: [], fenced };
}

/**
 * Prepare values for a renderer that does its OWN substitution — notably
 * Bedrock, which expands `{{…}}` server-side when a prompt ARN is the model.
 *
 * We cannot let that path off the hook: the fence has to be applied to the
 * VALUE before it leaves us, because after it reaches Bedrock the template is
 * no longer ours to wrap. Same trust rules as renderPrompt, applied one level
 * down — trusted values pass through, fenced ones arrive pre-wrapped and
 * pre-defanged.
 */
export function prepareValues(
  contract: PromptContract,
  values: Record<string, string>,
): { ok: boolean; values: Record<string, string>; issues: ValidationIssue[]; fenced: string[] } {
  const issues = validateValues(contract, values);
  if (issues.length > 0) return { ok: false, values, issues, fenced: [] };

  const byName = new Map(contract.variables.map((v) => [v.name, v]));
  const out: Record<string, string> = {};
  const fenced: string[] = [];

  // Union of what was supplied and what the contract declares, so a declared
  // default still reaches the renderer.
  const names = new Set([...Object.keys(values), ...byName.keys()]);
  for (const name of names) {
    const spec = byName.get(name);
    const value = values[name] ?? spec?.default ?? '';
    const source: VarSource = spec?.source ?? 'untrusted';
    if (!isFenced(source)) { out[name] = value; continue; }
    fenced.push(name);
    const tag = fenceTag(source);
    out[name] = `<${tag} name="${name}">\n${defang(value)}\n</${tag}>`;
  }
  return { ok: true, values: out, issues: [], fenced };
}

// ─── Release gating ──────────────────────────────────────────────────────────

export interface DeployRefusal { ok: false; reason: string }
export type DeployDecision = { ok: true } | DeployRefusal;

/**
 * May this version be deployed at its declared tier?
 *
 * The ceremony scales with blast radius, which is the whole point of the tier:
 * a sandbox asset answers to nobody, an internal one needs an owner and a
 * green eval, and an endpoint asset — reachable from outside, quite possibly
 * fed untrusted text — also needs a bound guardrail and a fully typed
 * contract. Enforced here rather than remembered by a reviewer.
 */
export function decideDeploy(
  contract: PromptContract,
  template: string,
  ctx: { hasOwner: boolean; evalPassRate: number | null; signoffs: number },
): DeployDecision {
  const drift = contractDrift(template, contract);
  if (contract.tier === 'sandbox') return { ok: true };

  if (drift.undeclared.length > 0) {
    return { ok: false, reason: `undeclared variables would render as untrusted: ${drift.undeclared.join(', ')}` };
  }
  if (!ctx.hasOwner) return { ok: false, reason: 'no owner — an internal or endpoint asset needs someone accountable' };
  if (ctx.evalPassRate == null) return { ok: false, reason: 'no eval baseline — run this asset\'s eval set first' };
  if (ctx.evalPassRate < 0.8) {
    return { ok: false, reason: `eval pass rate ${Math.round(ctx.evalPassRate * 100)}% is below the 80% bar` };
  }
  if (contract.tier === 'internal') return { ok: true };

  // Endpoint tier only from here.
  if (!contract.guardrailId) return { ok: false, reason: 'endpoint tier needs a bound guardrail' };
  if (ctx.signoffs < 2) {
    return { ok: false, reason: `endpoint tier needs 2 sign-offs, has ${ctx.signoffs}` };
  }
  return { ok: true };
}
