import type { ContactRow } from './socialPlatform.ts';

export type ContactPresence = 'all' | 'here' | 'online' | 'away' | 'offline';
export interface ContactFilters { query: string; presence: ContactPresence }
export type ContactCommand =
  | { kind: 'search'; query: string }
  | { kind: 'presence'; presence: ContactPresence }
  | { kind: 'reset' | 'refresh' | 'help' }
  | { kind: 'open'; target: string };

function unquote(text: string): string {
  return /^(?:"[^"]*"|'[^']*')$/.test(text) ? text.slice(1, -1).trim() : text.trim();
}
export function parseContactCommand(text: string): ContactCommand {
  const raw = text.trim().replace(/^please\s+/i, '');
  if (!raw || raw.length > 500) throw new Error('Use a supported contact command. Open Available contacts commands for examples.');
  const simple = raw.toLowerCase().replace(/[.!?]+$/, '').trim();
  if (/^(?:help|commands|what can i do)$/.test(simple)) return { kind: 'help' };
  if (/^(?:refresh|reload)(?: (?:the )?(?:contacts|people|table))?$/.test(simple)) return { kind: 'refresh' };
  if (/^(?:reset(?: filters)?|clear (?:all )?filters|show all (?:people|contacts))$/.test(simple)) return { kind: 'reset' };
  // A question about who is around: "who's online now", "who is here", "who is away".
  const asked = /^who(?:'s|\s+is|\s+are)?\s+(?:(?:currently|right now)\s+)?(here|online|around|available|on(?:\s*line)?|away|idle|offline|not here)(?:\s+(?:now|right now|today))?$/.exec(simple);
  if (asked) {
    const w = asked[1]!;
    return { kind: 'presence', presence: w === 'here' || w === 'available' ? 'here' : w === 'away' || w === 'idle' ? 'away' : w === 'offline' || w === 'not here' ? 'offline' : 'online' };
  }
  const presence = /^(?:(?:show|status)\s+)?(here(?: now)?|online|away|offline|all)(?:\s+(?:people|contacts))?$/.exec(simple)
    ?? /^show (?:people|contacts) (here(?: now)?|online|away|offline)$/.exec(simple);
  if (presence) return { kind: 'presence', presence: presence[1].startsWith('here') ? 'here' : presence[1] as ContactPresence };
  const search = /^(?:search (?:contacts|people)(?: for)?|search for|find (?:person|people|contacts) named)\s+(.+)$/i.exec(raw);
  if (search) {
    const query = unquote(search[1]);
    if (!query) throw new Error('Supply a name to search.');
    return { kind: 'search', query };
  }
  const open = /^(?:open|message)\s+(.+)$/i.exec(raw);
  if (open) {
    const target = unquote(open[1]);
    if (!target || /^(?:all|all contacts|all people|everyone|everybody|everything|these|selected|selected contacts|me|myself|self)$/i.test(target)) {
      throw new Error('Choose one other person by their exact name or user ID. Group and self conversations are not available here.');
    }
    return { kind: 'open', target };
  }
  throw new Error('Command not recognized. Open Available contacts commands for supported phrases. No changes were made.');
}

export function filterContacts(rows: readonly ContactRow[], filters: ContactFilters): ContactRow[] {
  const query = filters.query.toLowerCase().trim();
  return rows.filter(row => (!query || row.displayName.toLowerCase().includes(query) || row.userId.toLowerCase().includes(query))
    && (filters.presence === 'all' || (filters.presence === 'here' ? row.online && !row.idle
      : filters.presence === 'away' ? row.online && row.idle : filters.presence === 'online' ? row.online : !row.online)));
}

/** The presence tally of the loaded roster, as one sentence: who is here now, how many are away or offline. */
export function presenceTally(rows: readonly ContactRow[], selfId: string): string {
  const name = (r: ContactRow) => (r.userId === selfId ? `${r.displayName} (you)` : r.displayName);
  const here = rows.filter(r => r.online && !r.idle), away = rows.filter(r => r.online && r.idle), off = rows.filter(r => !r.online);
  const some = (list: readonly ContactRow[]) => (list.length ? ` (${list.slice(0, 4).map(name).join(', ')}${list.length > 4 ? `, and ${list.length - 4} more` : ''})` : '');
  return `Here now: ${here.length}${some(here)}. Away: ${away.length}${some(away)}. Offline: ${off.length} of ${rows.length} people.`;
}

/** Target resolution uses only the current filtered table. Opening a DM does
 * not send message content, ring a call, or choose among ambiguous names. */
export function resolveContactTarget(target: string, rows: readonly ContactRow[], selfId: string, mayMessage: boolean): ContactRow {
  if (!mayMessage) throw new Error('Opening a direct message requires permission to send messages in this workspace.');
  const id = rows.find(row => row.userId === target);
  const query = target.toLowerCase();
  const exact = rows.filter(row => row.displayName.toLowerCase() === query);
  const candidates = id ? [id] : exact.length ? exact : rows.filter(row => row.displayName.toLowerCase().includes(query));
  if (!candidates.length) throw new Error('No matching person in the current table. Clear or change the filters, then use their name or user ID.');
  if (candidates.length > 1) throw new Error(`That matches ${candidates.length} people. Use an exact user ID: ${candidates.slice(0, 3).map(row => row.userId).join(', ')}.`);
  if (candidates[0].userId === selfId) throw new Error('Choose another person. This page does not open a conversation with yourself.');
  return candidates[0];
}

export function contactCommandExamples(mayMessage: boolean): string[] {
  return ['show here contacts', 'show away contacts', 'show offline contacts', 'show all contacts', 'who is online',
    'search contacts for "Farah"', 'reset filters', 'refresh',
    ...(mayMessage ? ['open <name or user ID>', 'message <name or user ID> — opens the conversation; sends no text'] : [])];
}
