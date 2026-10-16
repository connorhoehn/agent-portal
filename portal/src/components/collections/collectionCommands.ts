// The one bounded grammar every collection page's command composer speaks.
// A command maps to the same controlled toolbar state the page already has
// (search, one filter, refresh, reset) or opens exactly one record. Nothing
// here interprets prose as a mutation or hands text to an agent; a page that
// needs more declares it explicitly through `extra` phrases with their own
// handlers, and says so in its help and scope note.
import type { CollectionCommandAdapter, CollectionCommandResult } from './CollectionCommandHost.tsx';
import type { TenantAnswerFact } from '../../lib/tenantAnswer.ts';

export type CollectionCommand = { kind: 'help' | 'refresh' | 'reset' }
  | { kind: 'open'; target: string } | { kind: 'search'; query: string } | { kind: 'filter'; value: string } | { kind: 'extra'; phrase: string };

export interface CollectionGrammar {
  /** The plural noun the composer speaks about, lower case ("work items", "sources"). */
  noun: string;
  /** Explicit phrase → controlled filter value; `show <phrase> <noun>` and `filter <phrase>` both apply it. */
  filters?: Record<string, string>;
  /** Additional exact phrases (lower case) the page handles itself through `controls.extra`. */
  extra?: readonly string[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(?:"[^"]*"|'[^']*'|“[^”]*”)$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
}

export function parseCollectionCommand(text: string, grammar: CollectionGrammar): CollectionCommand {
  const { noun, filters = {}, extra = [] } = grammar;
  const raw = text.trim().replace(/^please\s+/i, '');
  if (!raw || raw.length > 500) throw new Error('Enter a supported table command of at most 500 characters.');
  const simple = raw.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(help|commands|what can i do)$/.test(simple)) return { kind: 'help' };
  if (['refresh', 'reload', `refresh ${noun}`, `reload ${noun}`].includes(simple)) return { kind: 'refresh' };
  if (['reset', 'reset filters', 'clear filters', 'clear all filters', 'clear search', `show all ${noun}`].includes(simple)) return { kind: 'reset' };
  const search = new RegExp(`^(?:search ${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: for)?|search for|search|find)\\s+(.+)$`, 'i').exec(raw);
  if (search) {
    const query = unquote(search[1]);
    if (!query) throw new Error('Supply text to search.');
    return { kind: 'search', query };
  }
  const open = /^open\s+(.+)$/i.exec(raw);
  if (open) {
    const target = unquote(open[1]);
    if (!target || /^(?:all|all records|all rows|everything|everyone|these|those|selected|selected rows)$/i.test(target)) {
      throw new Error('Choose one record by its exact ID or title.');
    }
    return { kind: 'open', target };
  }
  for (const [phrase, value] of Object.entries(filters)) {
    if (simple === `show ${phrase} ${noun}` || simple === `filter ${phrase}` || simple === `show ${phrase}`) return { kind: 'filter', value };
  }
  if (extra.includes(simple)) return { kind: 'extra', phrase: simple };
  throw new Error(`Command not recognized. Open Available ${noun} commands for supported phrases. No changes were made.`);
}

export interface CollectionControls {
  setQuery(value: string): void;
  setFilter?(value: string): void;
  refresh(): void;
  /** One sentence on what the commands touch and what they never do. */
  scopeNote: string;
  /** Resolve one record by exact ID or title and open it; return the confirmation message. */
  open?(target: string): string;
  /** Handle a page-specific phrase declared in `grammar.extra`. */
  extra?(phrase: string): CollectionCommandResult | Promise<CollectionCommandResult>;
  /** Narrow the page's rows to the records a fixed-fact answer cites (null restores them). */
  showAnswer?(answer: TenantAnswerFact | null): void;
  /** Shown as the composer's label; defaults to the capitalised noun. */
  label?: string;
  id?: string;
}

/** Build the adapter a `CollectionCommandHost` renders for one collection page. */
export function collectionCommandAdapter(grammar: CollectionGrammar, controls: CollectionControls): CollectionCommandAdapter {
  const { noun, filters = {}, extra = [] } = grammar;
  const label = controls.label ?? noun[0].toUpperCase() + noun.slice(1);
  const examples = [
    `search ${noun} for "name"`,
    ...Object.keys(filters).map(value => `show ${value} ${noun}`),
    'reset filters', 'refresh',
    ...(controls.open ? ['open <exact ID or title>'] : []),
    ...extra,
  ];
  return {
    id: controls.id ?? `${noun.replace(/\s+/g, '-')}-commands`, label, examples, scopeNote: controls.scopeNote,
    ...(controls.showAnswer ? { showAnswer: controls.showAnswer } : {}),
    placeholder: `Search ${noun}${Object.keys(filters).length ? ', filter' : ''}${controls.open ? ', open a record' : ''}, or refresh…`,
    async execute(text) {
      const command = parseCollectionCommand(text, grammar);
      switch (command.kind) {
        case 'open':
          if (!controls.open) throw new Error('Opening records is not available here. No changes were made.');
          return { message: controls.open(command.target) };
        case 'help': return { message: `Supported: ${examples.join('; ')}. ${controls.scopeNote}` };
        case 'refresh': controls.refresh(); return { message: `Refreshing ${noun}.` };
        case 'reset': controls.showAnswer?.(null); controls.setQuery(''); controls.setFilter?.(''); return { message: 'Search and filters cleared. Sorting is unchanged.' };
        case 'search': controls.setQuery(command.query); return { message: `Searching loaded ${noun} for “${command.query}”. Other filters and sorting are unchanged.` };
        case 'filter':
          if (!controls.setFilter) throw new Error('This table has no filter to apply. No changes were made.');
          controls.setFilter(command.value); return { message: `Filter: ${command.value.replaceAll('-', ' ')}. Search and sorting are unchanged.` };
        case 'extra':
          if (!controls.extra) throw new Error('This command is not available here.');
          return controls.extra(command.phrase);
      }
    },
  };
}

/** Resolve only the current filtered rows. IDs keep their case; an exact display
 * title must identify one row; no fuzzy or bulk navigation. */
export function resolveCollectionTarget<T extends { id: string; title: string }>(target: string, rows: readonly T[]): T {
  const byId = rows.find(row => row.id === target);
  if (byId) return byId;
  const matches = rows.filter(row => row.title.toLowerCase() === target.toLowerCase());
  if (!matches.length) throw new Error('No matching record in the current table. Use its exact ID or title, or clear the search.');
  if (matches.length > 1) throw new Error('That title matches multiple records. Use an exact ID.');
  return matches[0];
}
