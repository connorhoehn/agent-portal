// lintRunbook (design §2.3): ten mechanical rules, each derived from one of
// the ten procedural facts the design quotes verbatim (§1.4). Applied to every
// version from every author — a person's edit, a run's `lab propose`, the
// migration's rewrites. A version with any `error` cannot be accepted.
//
// Pure: the only outside knowledge (which /api routes exist, which repo
// scripts exist) arrives in LintContext; repo-context.ts builds one from the
// tree. Without it R-command-real checks nothing and says so in no finding.
import type { LintFinding, LintRuleId, RunbookCommand, RunbookDoc, RunbookFile } from './types.js';
import { similarity, tokens } from './similarity.js';
import { FILE_LIMITS, checkFilePath } from './files.js';
import { checkSkillDescription, checkSkillName, skillDescription } from './skill.js';

export interface LintContext {
  /** Mounted routes, e.g. from mock/core/wire/snapshots/routes.json. */
  routes?: ReadonlyArray<{ method: string; path: string }>;
  /** Whether a repo-relative path exists ("scripts/validate-mock-floor.sh"). */
  pathExists?: (repoRelativePath: string) => boolean;
  /**
   * R8: the files this version carries. When given, the bundle rules run
   * (R-file-*, R-script-header, R-bundle-verify) and a command's scripts/… or
   * data/… path is real when the bundle holds it, repository or not.
   */
  files?: readonly RunbookFile[];
  /**
   * R8: the skill this runbook becomes — its name (the runbook id, or the
   * proposed one) and the other skills already in the library or on a box,
   * for R-skill-collision. Without it the description is still checked.
   */
  skill?: { name: string | null; others?: ReadonlyArray<{ name: string; description: string }> };
}

export interface LintRule { id: LintRuleId; severity: 'error' | 'warning'; summary: string; example: string }

/** The rule table, in the design's order, with the bad example each one was derived from. */
export const LINT_RULES: readonly LintRule[] = [
  { id: 'R-imperative', severity: 'error', summary: "a step's `do` does not start with an imperative verb", example: 'examples 1, 2, 4, 5, 8 ("Agents read their system prompt…")' },
  { id: 'R-joined', severity: 'error', summary: 'a step or the summary joins two sentences ("; " or two sentence ends)', example: 'examples 6, 7 ("…allowlist short; A per-tenant…")' },
  { id: 'R-generated', severity: 'error', summary: 'machine text: "(+N more)", "Load-corpus", "Uncompacted write"', example: 'examples 6, 7, 10' },
  { id: 'R-commandless', severity: 'error', summary: 'a step names a flag, route, CLI, identifier or path but carries no command', example: 'example 3 ("needs both enableEval and enableOnlineEvalConfig context flags")' },
  { id: 'R-verify', severity: 'error', summary: 'no Verify entry, or no step says what to expect', example: 'examples 4, 5, 9' },
  { id: 'R-rollback', severity: 'error', summary: 'steps change state but there is no Roll back', example: 'example 9 (the flip-back hidden as step 4)' },
  { id: 'R-single-subject', severity: 'warning', summary: 'more than half the steps share no term with the title and "use when"', example: 'examples 1, 2, 4, 5 (three clusters chunked into one procedure)' },
  { id: 'R-command-real', severity: 'error', summary: 'a command calls an /api route or repo script that does not exist', example: 'invented commands (example 3 given a made-up route)' },
  { id: 'R-length', severity: 'error', summary: 'title > 80, summary > 200, or a step > 160 characters', example: 'examples 1, 4 (summaries of 500+ characters)' },
  { id: 'R-secrets', severity: 'error', summary: 'text or a carried file carries something shaped like a credential', example: 'leaked tokens' },
  // R8 — a runbook carries scripts and data like a skill does, and becomes one.
  { id: 'R-file-path', severity: 'error', summary: 'a carried file is not at a safe bundle path under scripts/ or data/', example: 'a captured tool at ../../.ssh/config or /etc/passwd' },
  { id: 'R-file-size', severity: 'error', summary: `a carried file is over ${FILE_LIMITS.file_bytes} bytes, or all of them over ${FILE_LIMITS.bundle_bytes}`, example: 'a recorded HAR pasted whole into data/' },
  { id: 'R-file-unreferenced', severity: 'error', summary: 'a carried file is never named by a step, a verify check or a roll-back step', example: 'scratch files a run left in its keep folder' },
  { id: 'R-file-missing', severity: 'error', summary: 'a command names scripts/… or data/… that neither the bundle nor the repository holds', example: 'node scripts/replay.mjs data/frames.jsonl with no data/frames.jsonl' },
  { id: 'R-script-header', severity: 'error', summary: 'a script does not declare its runtime and dependencies in its header', example: 'a .mjs that needs Node 22 global WebSocket and says nothing' },
  { id: 'R-bundle-verify', severity: 'error', summary: 'a runbook with scripts has no Verify command that runs one against bundled data', example: 'a CDP harness nobody can check offline' },
  { id: 'R-skill-description', severity: 'error', summary: "the skill name or description breaks Claude Code's rules, or never says when to use it", example: 'no "Use when", or a description over 1,024 characters' },
  { id: 'R-skill-collision', severity: 'error', summary: "the skill's name or description collides with another skill's", example: 'two "debug websocket" skills Claude cannot tell apart' },
];
const SEVERITY = new Map(LINT_RULES.map((r) => [r.id, r.severity]));

export const LIMITS = { title: 80, summary: 200, step: 160 } as const;

/**
 * Verbs a step may open with. A step is an instruction; "Agents read…",
 * "Any Bedrock list API…", "Sampling decision waits…" are descriptions.
 */
export const IMPERATIVE_VERBS: ReadonlySet<string> = new Set(`
add adjust allow apply approve archive ask assign attach attribute audit back bring build bump call cancel cap capture change check
choose clean clear click clone close collect commit compare compute configure confirm connect copy create cut decide define delete
deploy describe detach diff disable dispatch do download drain drop edit email emit empty enable ensure escalate estimate exclude
expire export extend fetch file fill filter find fix flag flip follow forward freeze generate get give grant group hand handle hold
import include increase ingest inspect install invite keep kill label leave limit link list load lock log look lower make map mark
measure merge migrate mint mirror move name note notify open order page pair park pass paste patch pause pick pin ping plan point poll
post prefer prepare press print promote propose protect prove publish pull push put query queue raise read rebase rebuild record redeploy
reduce refresh regenerate register reject reload remove rename render reopen repeat replace reply report request require rerun reset
resize resolve restart restore resume retire retry return revert review revoke roll rotate route run save scale scan schedule search
seal select send separate set share ship sign skip snapshot sort split stage start stop store submit summarise summarize switch sync tag
tail take tear tell test tighten time toggle trace track trigger trim turn type unblock undo unpin unset update upgrade upload use
validate verify wait walk warn watch wire wrap write
`.split(/\s+/).filter(Boolean));

/** Verbs that change state: a runbook that opens a step with one of these needs a Roll back. */
export const MUTATING_VERBS: ReadonlySet<string> = new Set(`
add apply attach bump cap change create cut delete deploy detach disable dispatch drain drop enable expire flag flip grant import ingest
install kill lock merge migrate mint move patch pin promote publish push put raise rebuild redeploy remove rename replace reset resize
restart restore retire revert revoke roll rotate route scale set ship switch tag tear toggle turn unpin unset update upgrade upload wire
write
`.split(/\s+/).filter(Boolean));

const MUTATING_COMMAND = /(^|\s)-X\s*(POST|PUT|PATCH|DELETE)\b|^\s*(POST|PUT|PATCH|DELETE)\s+\/|\baws\s+[\w-]+\s+(create|update|put|delete|modify|attach|detach|start|stop|terminate|register|deregister|tag|untag)-[\w-]+|\bcdk\s+(deploy|destroy)\b|\bdeploy\.sh\b|\bdestroy\.sh\b|^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b|\bgit\s+push\b|\bkubectl\s+(apply|delete|scale|rollout)\b/im;

const GENERATED = /\(\+\d+ more\)|Load-corpus|Uncompacted write/;

const SECRETS: ReadonlyArray<[string, RegExp]> = [
  ['an AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['an AWS secret access key', /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+]{30,}/i],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['an API key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['a bearer token', /\bBearer\s+(?!\$)[A-Za-z0-9._~+/-]{24,}=*/],
  ['a literal password', /\b(password|passwd|secret|token)\s*[=:]\s*(?!\$|<|\{|\*|process\.env\b|os\.environ\b|(?:os\.)?getenv\b)["']?[^\s"'$<{]{8,}/i],
];

/** Things a step mentions that only a command can make exact (R-commandless). */
const NEEDS_COMMAND: ReadonlyArray<[string, RegExp]> = [
  ['a CLI flag', /(^|\s)--[a-z][\w-]*/],
  ['an API route', /\/api\//],
  ['a context flag', /\bcontext flags?\b/i],
  ['a code span', /`[^`]+`/],
  ['a file path', /\b[\w.-]+\/[\w.-]+\.(sh|mjs|cjs|js|ts|tsx|py|sql|json|ya?ml|toml|cedar|md)\b/],
  ['a CLI', /(^|\s)(aws|cdk|npm|npx|curl|git|gh|docker|tilt|kubectl|psql|jq)\s/],
  ['an identifier', /\b[a-z]+[A-Z][A-Za-z0-9]*\b/],
  ['an environment variable', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/],
];

/** A bundle-relative path in text: scripts/x.mjs, data/frames.jsonl. */
const BUNDLE_PATH = /(?:^|[\s"'=(`])(?:\.\/)?((?:scripts|data)\/[A-Za-z0-9_][A-Za-z0-9._/-]*[A-Za-z0-9_])/g;
/** Collision: descriptions this alike (token Jaccard) cannot be told apart by a model choosing a skill. */
export const SKILL_COLLISION_THRESHOLD = 0.8;
/** How far into a script its header may run. */
const HEADER_LINES = 15;

const ROUTE_IN_COMMAND = /\/api\/[A-Za-z0-9_\-/:.$%{}<>]*/g;
const REPO_PATH_IN_COMMAND = /(?:^|[\s"'=(])(?:\.\/)?((?:scripts|tools|agents|infra|middleware|portal|schema|docs)\/[A-Za-z0-9_./-]+\.(?:sh|mjs|cjs|js|ts|py|sql|json))\b/g;

/** First word of an instruction, lowercased, hyphen-prefix kept ("Tail-sample" → "tail"). */
export function leadingWord(text: string): string {
  const m = /^[\s*_"'`(]*([A-Za-z][A-Za-z']*)/.exec(text);
  return m ? m[1]!.toLowerCase().replace(/'.*$/, '') : '';
}

function stripCode(text: string): string {
  return text.replace(/`[^`]*`/g, '`…`');
}

/** Two sentences in one field: "; " between clauses, or a sentence end followed by a capitalised word. */
export function joinsSentences(text: string): boolean {
  const t = stripCode(text);
  if (/;\s/.test(t)) return true;
  return /[a-z0-9)][.!?]\s+[A-Z]/.test(t.replace(/\b(e\.g|i\.e|vs|etc|approx|cf)\./gi, '$1'));
}

/** "/api/runs/:ref/brief" matches "/api/runs/job-1/brief" and "/api/runs/$REF/brief". */
export function routeMatches(template: string, used: string): boolean {
  const a = template.replace(/\/+$/, '').split('/');
  const b = used.replace(/[).,;:'"]+$/, '').replace(/\/+$/, '').split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, k) => seg === b[k] || seg.startsWith(':') || seg === '*' || /^[$<{]/.test(b[k]!) || /\$\{?[A-Z_]/.test(b[k]!));
}

interface Field { path: string; text: string }

function allText(doc: RunbookDoc): Field[] {
  const out: Field[] = [{ path: 'title', text: doc.title }, { path: 'summary', text: doc.summary }];
  doc.use_when.forEach((t, i) => out.push({ path: `use_when[${i}]`, text: t }));
  doc.not_for.forEach((t, i) => out.push({ path: `not_for[${i}]`, text: t }));
  doc.preconditions.forEach((t, i) => out.push({ path: `preconditions[${i}]`, text: t }));
  doc.steps.forEach((s, i) => {
    out.push({ path: `steps[${i}].do`, text: s.do });
    if (s.command) out.push({ path: `steps[${i}].command`, text: s.command.text });
    if (s.expect) out.push({ path: `steps[${i}].expect`, text: s.expect });
    if (s.why) out.push({ path: `steps[${i}].why`, text: s.why });
  });
  doc.verify.forEach((v, i) => {
    out.push({ path: `verify[${i}].check`, text: v.check });
    if (v.command) out.push({ path: `verify[${i}].command`, text: v.command.text });
  });
  doc.failure_modes.forEach((f, i) => out.push({ path: `failure_modes[${i}]`, text: `${f.symptom} | ${f.cause} | ${f.response}` }));
  doc.rollback.forEach((r, i) => {
    out.push({ path: `rollback[${i}].do`, text: r.do });
    if (r.command) out.push({ path: `rollback[${i}].command`, text: r.command.text });
  });
  if (doc.notes) out.push({ path: 'notes', text: doc.notes });
  return out;
}

function commands(doc: RunbookDoc): Array<{ path: string; command: RunbookCommand }> {
  const out: Array<{ path: string; command: RunbookCommand }> = [];
  doc.steps.forEach((s, i) => { if (s.command) out.push({ path: `steps[${i}].command`, command: s.command }); });
  doc.verify.forEach((v, i) => { if (v.command) out.push({ path: `verify[${i}].command`, command: v.command }); });
  doc.rollback.forEach((r, i) => { if (r.command) out.push({ path: `rollback[${i}].command`, command: r.command }); });
  return out;
}

/** True when following the steps changes something a Roll back would have to undo. */
export function changesState(doc: RunbookDoc): boolean {
  return doc.steps.some((s) => MUTATING_VERBS.has(leadingWord(s.do)) || (s.command !== undefined && MUTATING_COMMAND.test(s.command.text)));
}

export function lintRunbook(doc: RunbookDoc, ctx: LintContext = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const add = (rule: LintRuleId, path: string, message: string) =>
    findings.push({ rule, severity: SEVERITY.get(rule)!, path, message });

  // R-imperative — a step (and a roll-back step) is an instruction.
  const instructions = [
    ...doc.steps.map((s, i) => ({ path: `steps[${i}].do`, text: s.do })),
    ...doc.rollback.map((r, i) => ({ path: `rollback[${i}].do`, text: r.do })),
  ];
  for (const { path, text } of instructions) {
    const w = leadingWord(text);
    if (!IMPERATIVE_VERBS.has(w)) add('R-imperative', path, `"${text.slice(0, 60)}" opens with "${w || text.slice(0, 12)}", not an instruction — start with what to do ("Confirm…", "Run…", "Add…")`);
  }

  // R-joined — one sentence per step and per summary.
  for (const { path, text } of [{ path: 'summary', text: doc.summary }, ...instructions]) {
    if (joinsSentences(text)) add('R-joined', path, 'joins two sentences; split it into two steps, or keep the one that is the instruction');
  }

  // R-generated — machine strings shown to a person as knowledge.
  for (const { path, text } of allText(doc)) {
    const m = GENERATED.exec(text);
    if (m) add('R-generated', path, `carries machine text "${m[0]}"`);
  }

  // R-commandless — a step that names something exact must give the command.
  doc.steps.forEach((s, i) => {
    if (s.command) return;
    const hit = NEEDS_COMMAND.find(([, re]) => re.test(s.do));
    if (hit) add('R-commandless', `steps[${i}]`, `names ${hit[0]} but gives no command — add the exact command and what it should print`);
  });

  // R-verify — a reader must be able to tell it worked.
  if (doc.verify.length === 0) add('R-verify', 'verify', 'no Verify section: say how to confirm the whole procedure worked');
  if (doc.steps.length > 0 && !doc.steps.some((s) => s.expect !== undefined)) add('R-verify', 'steps', 'no step says what you should see ("Expect …")');
  if (doc.steps.length === 0) add('R-verify', 'steps', 'no steps');

  // R-rollback — anything that changes state has a way back.
  if (doc.rollback.length === 0 && changesState(doc)) add('R-rollback', 'rollback', 'the steps change state but there is no Roll back section');

  // R-single-subject — a procedure is about one thing.
  if (doc.steps.length > 0) {
    const subject = new Set(tokens([doc.title, ...doc.use_when].join(' ')));
    const off = doc.steps.map((s, i) => ({ i, t: tokens(s.do) })).filter(({ t }) => !t.some((x) => subject.has(x)));
    if (off.length * 2 > doc.steps.length) {
      add('R-single-subject', 'steps', `${off.length} of ${doc.steps.length} steps share no term with the title or "use when" (steps ${off.map((o) => o.i + 1).join(', ')}) — is this more than one procedure?`);
    }
  }

  // R-command-real — commands call things that exist.
  for (const { path, command } of commands(doc)) {
    if (ctx.routes) {
      for (const m of command.text.matchAll(ROUTE_IN_COMMAND)) {
        const used = m[0].replace(/[).,;:'"]+$/, '');
        if (!ctx.routes.some((r) => routeMatches(r.path, used))) add('R-command-real', path, `calls ${used}, which no mounted route serves`);
      }
    }
    const inBundle = (p: string) => !!ctx.files?.some((f) => f.path === p);
    if (ctx.pathExists) {
      for (const m of command.text.matchAll(REPO_PATH_IN_COMMAND)) {
        if (!inBundle(m[1]!) && !ctx.pathExists(m[1]!)) add('R-command-real', path, ctx.files?.length ? `runs ${m[1]}, which is neither in this runbook's files nor in the repository` : `runs ${m[1]}, which is not in the repository`);
      }
    }
  }

  // R-length — run-on text.
  if (doc.title.length > LIMITS.title) add('R-length', 'title', `title is ${doc.title.length} characters (max ${LIMITS.title})`);
  if (doc.summary.length > LIMITS.summary) add('R-length', 'summary', `summary is ${doc.summary.length} characters (max ${LIMITS.summary})`);
  for (const { path, text } of instructions) {
    if (text.length > LIMITS.step) add('R-length', path, `step is ${text.length} characters (max ${LIMITS.step})`);
  }

  // R-secrets — never ship a credential to every box.
  for (const { path, text } of allText(doc)) {
    const hit = SECRETS.find(([, re]) => re.test(text));
    if (hit) add('R-secrets', path, `contains what looks like ${hit[0]} — use an environment variable or a secret reference`);
  }

  lintBundle(doc, ctx, add);
  lintSkill(doc, ctx, add);
  return findings;
}

type Add = (rule: LintRuleId, path: string, message: string) => void;

/** Bundle-relative paths a text names. */
export function bundlePaths(text: string): string[] {
  return [...text.matchAll(BUNDLE_PATH)].map((m) => m[1]!.replace(/[.,;:)]+$/, ''));
}

/** Every text a step, verify check or roll-back step carries — where a file must be named to count as used. */
function procedureTexts(doc: RunbookDoc): string[] {
  return [
    ...doc.steps.flatMap((s) => [s.do, s.command?.text ?? '', s.expect ?? '']),
    ...doc.verify.flatMap((v) => [v.check, v.command?.text ?? '']),
    ...doc.rollback.flatMap((r) => [r.do, r.command?.text ?? '']),
  ];
}

/** Does a script's header say what it runs on and what it needs? */
export function declaresRuntime(content: string): boolean {
  const head = content.split('\n').slice(0, HEADER_LINES).join('\n');
  return /\bruntime\s*:/i.test(head) && /\b(deps|dependencies|requires)\s*:/i.test(head);
}

function lintBundle(doc: RunbookDoc, ctx: LintContext, add: Add): void {
  const files = ctx.files;
  // R-file-missing — a data/ or scripts/ path a command names must exist somewhere.
  if (files !== undefined) {
    for (const { path, command } of commands(doc)) {
      for (const p of bundlePaths(command.text)) {
        if (files.some((f) => f.path === p)) continue;
        if (p.startsWith('scripts/') && ctx.pathExists) continue; // R-command-real already judged repo scripts
        if (ctx.pathExists?.(p)) continue;
        add('R-file-missing', path, `names ${p}, which this runbook does not carry${ctx.pathExists ? ' and the repository does not have' : ''}`);
      }
    }
  }
  if (!files || files.length === 0) return;

  let total = 0;
  for (const f of files) {
    const at = `files[${f.path}]`;
    const bad = checkFilePath(f.path);
    if (bad) add('R-file-path', at, bad);
    const size = Buffer.byteLength(f.content, 'utf8');
    total += size;
    if (size > FILE_LIMITS.file_bytes) add('R-file-size', at, `${size} bytes, over the ${FILE_LIMITS.file_bytes}-byte limit per file`);
    // R-secrets over contents: a script ships to every box in the org.
    const hit = SECRETS.find(([, re]) => re.test(f.content));
    if (hit) add('R-secrets', at, `contains what looks like ${hit[0]} — read it from an environment variable at run time`);
    if (f.path.startsWith('scripts/') && !declaresRuntime(f.content)) {
      add('R-script-header', at, 'declare the runtime and dependencies in the first lines, e.g. "// runtime: node >=22" and "// deps: none (node built-ins)"');
    }
  }
  if (total > FILE_LIMITS.bundle_bytes) add('R-file-size', 'files', `the files total ${total} bytes, over the ${FILE_LIMITS.bundle_bytes}-byte limit per runbook`);

  // R-file-unreferenced — every carried file earns its place in the procedure.
  const named = new Set(procedureTexts(doc).flatMap(bundlePaths));
  for (const f of files) {
    if (!named.has(f.path)) add('R-file-unreferenced', `files[${f.path}]`, `${f.path} is carried but no step, verify check or roll-back step names it — use it or drop it`);
  }

  // R-bundle-verify — a bundle with scripts proves itself offline: a Verify command runs a bundled script against bundled data.
  const scripts = files.filter((f) => f.path.startsWith('scripts/')).map((f) => f.path);
  if (scripts.length > 0) {
    const data = new Set(files.filter((f) => f.path.startsWith('data/')).map((f) => f.path));
    const proves = doc.verify.some((v) => {
      const used = v.command ? bundlePaths(v.command.text) : [];
      return used.some((p) => scripts.includes(p)) && used.some((p) => data.has(p));
    });
    if (!proves) add('R-bundle-verify', 'verify', `the runbook carries ${scripts.join(', ')} but no Verify command runs one against a bundled data/ file — add an offline check`);
  }
}

function lintSkill(doc: RunbookDoc, ctx: LintContext, add: Add): void {
  const description = skillDescription(doc);
  const bad = checkSkillDescription(description);
  if (bad) add('R-skill-description', 'description', bad);
  if (doc.use_when.length === 0) add('R-skill-description', 'use_when', 'say when to use it: Claude picks a skill by its description, and "Use when" is that half');
  const name = ctx.skill?.name ?? null;
  if (name) {
    const nameBad = checkSkillName(name);
    if (nameBad) add('R-skill-description', 'name', nameBad);
    for (const o of ctx.skill?.others ?? []) {
      if (o.name === name) continue; // the runbook's own current version
      if (o.name.toLowerCase() === name.toLowerCase()) { add('R-skill-collision', 'name', `another skill is already named ${o.name}`); continue; }
      const score = similarity(description, o.description);
      if (score >= SKILL_COLLISION_THRESHOLD) add('R-skill-collision', 'description', `reads like ${o.name} (similarity ${score.toFixed(2)}) — say what makes this one different, or propose an edit to ${o.name}`);
    }
  }
}

export function lintErrors(findings: readonly LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === 'error');
}
