import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { matchesDefinition, type RunbookRow } from '../../lib/pipelineDefinitions.ts';
import type { PipelineQueue } from '../../lib/pipelineQueues.ts';
import type { PipelineArtifact } from '../../lib/pipelineRuns.ts';

export type PipelineCollection = 'definitions' | 'workflows' | 'queues' | 'artifacts' | 'agents' | 'bots' | 'commands' | 'approvals';
export type PipelineCollectionCommand = { kind: 'help' | 'refresh' | 'reset' }
  | { kind: 'open'; target: string } | { kind: 'search'; query: string } | { kind: 'filter'; value: string };

/** Explicit phrases map to the same controlled filters as the toolbar. Never
 * interpret arbitrary prose as a destructive operation or an agent request. */
const FILTERS: Record<PipelineCollection, Record<string, string>> = {
  agents: {}, bots: {}, commands: {}, approvals: {},
  definitions: { runbook: 'runbook', bot: 'bot', agent: 'agent', 'assessment command': 'assessment-command' },
  workflows: { passed: 'passed', 'needs dry-run': 'needs-dry-run', promoted: 'promoted' },
  queues: { available: 'available', missing: 'missing', unavailable: 'unavailable', 'dead-letter': 'dead-letter', work: 'work' },
  artifacts: { change: 'change', document: 'document', scores: 'scores', transcript: 'transcript', trace: 'trace' },
};
export function parsePipelineCollectionCommand(text: string, collection: PipelineCollection): PipelineCollectionCommand {
  const raw = text.trim().replace(/^please\s+/i, '');
  if (!raw || raw.length > 500) throw new Error('Enter a supported table command of at most 500 characters.');
  const simple = raw.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(help|commands|what can i do)$/.test(simple)) return { kind: 'help' };
  if (['refresh', 'reload', `refresh ${collection}`, `reload ${collection}`].includes(simple)) return { kind: 'refresh' };
  if (['reset', 'reset filters', 'clear filters', 'clear all filters', `show all ${collection}`].includes(simple)) return { kind: 'reset' };
  const search = new RegExp(`^(?:search ${collection}(?: for)?|search for)\\s+(.+)$`, 'i').exec(raw);
  if (search) {
    let query = search[1].trim();
    if (/^(?:"[^"]*"|'[^']*')$/.test(query)) query = query.slice(1, -1).trim();
    if (!query) throw new Error('Supply text to search.');
    return { kind: 'search', query };
  }
  const open = /^open\s+(.+)$/i.exec(raw);
  if (open) {
    let target = open[1].trim();
    if (/^(?:"[^"]*"|'[^']*')$/.test(target)) target = target.slice(1, -1).trim();
    if (!target || /^(?:all|all records|all rows|everything|everyone|these|those|selected|selected rows)$/i.test(target)) {
      throw new Error('Choose one record by its exact ID or title.');
    }
    return { kind: 'open', target };
  }
  for (const [phrase, value] of Object.entries(FILTERS[collection])) {
    if (simple === `show ${phrase} ${collection}` || simple === `filter ${phrase}`) return { kind: 'filter', value };
  }
  throw new Error(`Command not recognized. Open Available ${collection} commands for supported phrases. No changes were made.`);
}

export function pipelineCollectionAdapter(collection: PipelineCollection, controls: {
  setQuery(value: string): void; setFilter?(value: string): void; refresh(): void; scopeNote: string; open?(target: string): string;
}): CollectionCommandAdapter {
  const label = collection[0].toUpperCase() + collection.slice(1);
  const examples = [`search ${collection} for "name"`, ...Object.keys(FILTERS[collection]).map(value => `show ${value} ${collection}`), 'reset filters', 'refresh', ...(controls.open ? ['open <exact ID or title>'] : [])];
  return {
    id: `pipelines-${collection}-commands`, label, examples, scopeNote: controls.scopeNote,
    placeholder: `Search ${collection}${Object.keys(FILTERS[collection]).length ? ", filter" : ""}, or refresh…`,
    execute(text) {
      const command = parsePipelineCollectionCommand(text, collection);
      if (command.kind === 'open') {
        if (!controls.open) throw new Error('Opening records is not available here. No changes were made.');
        return { message: controls.open(command.target) };
      }
      if (command.kind === 'help') return { message: `Supported: ${examples.join('; ')}. ${controls.scopeNote}` };
      if (command.kind === 'refresh') { controls.refresh(); return { message: `Refreshing ${collection}.` }; }
      if (command.kind === 'reset') { controls.setQuery(''); controls.setFilter?.(''); return { message: 'Search and filters cleared. Sorting is unchanged.' }; }
      if (command.kind === 'search') { controls.setQuery(command.query); return { message: `Searching loaded ${collection} for “${command.query}”. Other filters and sorting are unchanged.` }; }
      if (command.kind === 'filter') { controls.setFilter?.(command.value); return { message: `Filter: ${command.value.replaceAll('-', ' ')}. Search and sorting are unchanged.` }; }
      throw new Error('This command is not available here.');
    },
  };
}
export function filterRunbooks(rows: readonly RunbookRow[], query: string, filter: string): RunbookRow[] {
  return rows.filter(row => matchesDefinition(row, query) && (!filter
    || (filter === 'promoted' ? row.runbook.candidateStatus === 'promoted'
      : filter === 'passed' ? row.runbook.promotionToSkill.ok && row.runbook.candidateStatus !== 'promoted'
      : filter === 'needs-dry-run' ? !row.runbook.promotionToSkill.ok && row.runbook.candidateStatus !== 'promoted' : false)));
}
export function filterQueues(rows: readonly PipelineQueue[], query: string, filter: string): PipelineQueue[] {
  return rows.filter(row => `${row.name} ${row.purpose}`.toLowerCase().includes(query.trim().toLowerCase())
    && (!filter || (filter === 'dead-letter' ? row.deadLetter : filter === 'work' ? !row.deadLetter : row.state === filter)));
}
export function filterArtifacts(rows: readonly PipelineArtifact[], query: string): PipelineArtifact[] {
  const q = query.trim().toLowerCase();
  return rows.filter(row => [row.title, row.id, row.runId ?? '', row.contextTenant ?? ''].some(value => value.toLowerCase().includes(q)));
}

/** Resolve only the current filtered collection. IDs retain their case and an
 * exact display title must identify one row; no fuzzy or bulk navigation. */
export function resolvePipelineCollectionTarget<T extends { id: string; title: string }>(target: string, rows: readonly T[]): T {
  const id = rows.find(row => row.id === target);
  if (id) return id;
  const matches = rows.filter(row => row.title.toLowerCase() === target.toLowerCase());
  if (!matches.length) throw new Error('No matching record in the current table. Use its exact ID or title, or clear the search.');
  if (matches.length > 1) throw new Error('That title matches multiple records. Use an exact ID.');
  return matches[0];
}
