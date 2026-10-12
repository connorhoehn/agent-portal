// Bounded collection commands, not an AI interpreter. Unknown language never
// becomes an operation; target resolution is restricted to the loaded ledger.
import { isTerminalRun } from '../../pages/pipelines/runActions.ts';
import type { PipelineRun } from '../../lib/pipelineRuns.ts';

export interface RunFilters { status: string; kind: string; contextTenant: string; title: string }
export const EMPTY_RUN_FILTERS: RunFilters = { status: '', kind: '', contextTenant: '', title: '' };
export type RunCommand =
  | { kind: 'filter'; filters: Partial<RunFilters> }
  | { kind: 'reset' | 'refresh' | 'help' }
  | { kind: 'open'; target: string }
  | { kind: 'cancel'; target: string };

const STATUS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:awaiting approval|needs? approval)\b/g, 'awaiting_approval'],
  [/\b(?:paused at breakpoint|paused)\b/g, 'paused_at_breakpoint'],
  [/\b(?:succeeded|successful|completed|finished)\b/g, 'completed'],
  [/\b(?:pending|queued)\b/g, 'pending'],
  [/\brunning\b/g, 'running'], [/\bfailed\b/g, 'failed'],
  [/\brejected\b/g, 'rejected'], [/\b(?:cancelled|canceled)\b/g, 'cancelled'], [/\bstuck\b/g, 'stuck'],
];
const KINDS: ReadonlyArray<[RegExp, string]> = [
  [/\bassessment[ -]commands?\b/g, 'assessment-command'],
  [/\bagents?\b/g, 'agent'], [/\bbots?\b/g, 'bot'], [/\bcompactions?\b/g, 'compaction'],
];
const unsupported = () => new Error('Command not recognized. Open Available run commands for supported phrases. No changes were made.');
function unquote(text: string): string {
  const value = text.trim();
  return /^(?:"[^"]*"|'[^']*')$/.test(value) ? value.slice(1, -1).trim() : value;
}

export function parseRunCommand(text: string): RunCommand {
  const raw = text.trim().replace(/^please\s+/i, '');
  if (!raw || raw.length > 500) throw unsupported();
  const lower = raw.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(?:help|commands|what can i do)$/.test(lower)) return { kind: 'help' };
  if (/^(?:refresh|reload)(?: (?:the )?(?:runs|table|ledger))?$/.test(lower)) return { kind: 'refresh' };
  if (/^(?:reset(?: (?:all )?filters)?|clear (?:all )?filters|show all runs)$/.test(lower)) return { kind: 'reset' };
  const action = /^(open|cancel)\s+(?:run\s+)?(.+)$/i.exec(raw);
  if (action) {
    const target = unquote(action[2]);
    if (!target || /^(?:all|all runs|everything|every run|both|both runs|these|these runs|selected|selected runs|matching|matching runs)$/i.test(target)) {
      throw new Error('Choose one run by its exact title or ID. Bulk operations are not supported.');
    }
    return { kind: action[1].toLowerCase() as 'open' | 'cancel', target };
  }
  const search = /^(?:search(?: run)? titles(?: for)?|search for|find runs? (?:named|containing))\s+(.+)$/i.exec(raw);
  if (search) {
    const title = unquote(search[1]);
    if (!title) throw unsupported();
    return { kind: 'filter', filters: { title } };
  }
  if (!/^(?:show|list|filter|status|kind|workspace)\b/.test(lower)) throw unsupported();
  let rest = lower.replace(/^(?:show|list|filter)(?:\s+by)?\s+/, '');
  const filters: Partial<RunFilters> = {};
  const workspace = /\b(?:in|workspace)\s+(?:the\s+)?(work|orgiq|assessment)(?:\s+workspace)?\b/g;
  const workspaces = [...rest.matchAll(workspace)];
  if (workspaces.length > 1) throw new Error('Use one workspace at a time. No filters were changed.');
  if (workspaces.length) {
    filters.contextTenant = workspaces[0][1] === 'work' ? 'orgiq' : workspaces[0][1];
    rest = rest.replace(workspace, ' ');
  }
  for (const [pattern, value] of STATUS) {
    if (new RegExp(pattern.source).test(rest)) {
      if (filters.status) throw new Error('Use one status at a time. No filters were changed.');
      filters.status = value;
      rest = rest.replace(pattern, ' ');
    }
  }
  for (const [pattern, value] of KINDS) {
    if (new RegExp(pattern.source).test(rest)) {
      if (filters.kind) throw new Error('Use one kind at a time. No filters were changed.');
      filters.kind = value;
      rest = rest.replace(pattern, ' ');
    }
  }
  rest = rest.replace(/\b(?:runs?|status|kind|by|the)\b/g, '').trim();
  if (rest || !Object.keys(filters).length) throw unsupported();
  return { kind: 'filter', filters };
}

export function resolveRunTarget(target: string, runs: readonly PipelineRun[]): PipelineRun {
  const needle = target.toLowerCase();
  const id = runs.find(run => run.id === target);
  if (id) return id;
  const exact = runs.filter(run => run.context.title.toLowerCase() === needle);
  const candidates = exact.length ? exact : runs.filter(run => run.context.title.toLowerCase().includes(needle));
  if (!candidates.length) throw new Error('No matching run in the loaded table. Adjust the filters or refresh, then use its title or ID.');
  if (candidates.length > 1) throw new Error(`That matches ${candidates.length} runs. Use an exact run ID: ${candidates.slice(0, 3).map(run => run.id).join(', ')}.`);
  return candidates[0];
}

export interface RunCommandScope {
  runs: readonly PipelineRun[];
  endpoint: string;
  detailBase: string | null;
  showWorkspace: boolean;
  canCancel: boolean;
}
export type ResolvedRunCommand = Exclude<RunCommand, { kind: 'open' | 'cancel'; target: string }>
  | { kind: 'open' | 'cancel'; run: PipelineRun };

/** Re-run on confirmation: role, scope and terminal state may have changed. */
export function resolveRunCommand(command: RunCommand, scope: RunCommandScope): ResolvedRunCommand {
  if (command.kind === 'filter' && command.filters.contextTenant && !scope.showWorkspace) {
    throw new Error('This ledger is already restricted to its workspace. Workspace switching is available only in the Pipeline ledger.');
  }
  if (command.kind === 'open' && !scope.detailBase) throw new Error('This embedded ledger has no run detail page. Open the assessment command above instead.');
  if (command.kind === 'cancel' && (scope.endpoint !== '/api/pipelines/runs' || !scope.canCancel)) {
    throw new Error('Cancelling runs requires the CancelRun permission in the Pipeline workspace.');
  }
  if (command.kind === 'open' || command.kind === 'cancel') {
    const run = resolveRunTarget(command.target, scope.runs);
    if (command.kind === 'cancel' && isTerminalRun(run.status)) throw new Error('This run has already finished. Nothing was cancelled.');
    return { kind: command.kind, run };
  }
  return command;
}

export function runCommandExamples(scope: Pick<RunCommandScope, 'showWorkspace' | 'detailBase' | 'canCancel' | 'endpoint'>): string[] {
  return ['show failed runs', 'show running agent runs', 'show succeeded runs',
    ...(scope.showWorkspace ? ['show failed runs in work', 'workspace assessment'] : []),
    'kind assessment commands', 'search titles for "auth"', 'reset filters', 'refresh',
    ...(scope.detailBase ? ['open <run title or ID>'] : []),
    ...(scope.canCancel && scope.endpoint === '/api/pipelines/runs' ? ['cancel <run title or ID> — asks for confirmation'] : [])];
}
