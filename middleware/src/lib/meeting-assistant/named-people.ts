// Asked writes that name someone else (docs/meeting-consent-design.md, "Packages" item 7, and "Decided").
//
// The rules kept here:
//   - A write asked of Nova whose arguments name a person other than the asker becomes a proposal that needs that person's
//     consent (proposals.ts), with the asker as its executor. A write that names only the asker, or nobody, keeps the asker's card.
//   - Which arguments name a person is the explicit table below, per write tool. It fails closed: an argument that may hold a
//     person counts, and every write a meeting can offer must have a row (a test holds the table to the catalogue).
//   - A named person is resolved to a user id here on the server, from the call's roster (everyone who held a seat while Nova
//     was in, everyone seated now, and the inviter) and then the org directory: "me" is the asker, then an exact user id, an exact
//     display name, or a first name only one person has. A name that matches nobody, or several people, is refused.
//   - Nothing here logs a name or an argument.
import type { RosterEntry } from './minutes.js';

const capText = (v: string, n: number): string => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export type PersonRole = 'owner' | 'delegate' | 'participant' | 'recipient';

/** One argument that names a person: where it is in the arguments, what the person is to the write, and when it applies. */
export interface PersonArgument {
  /** The path to the value: a string, or (with `list`) an array of strings. */
  path: readonly string[];
  role: PersonRole;
  list?: boolean;
  /** Applies only when this holds of the arguments; absent, always. */
  when?: (args: Record<string, unknown>) => boolean;
}

/** A message's or a call's target names a person unless it says it is a team or a channel (an unknown kind counts). */
const targetIsPerson = (a: Record<string, unknown>): boolean => {
  const t = a['target'];
  const kind = t && typeof t === 'object' && !Array.isArray(t) ? (t as Record<string, unknown>)['kind'] : undefined;
  return kind !== 'team' && kind !== 'channel';
};

/**
 * Every write a meeting can offer, and the arguments of it that name a person. An empty row is a decision that the tool names
 * nobody: set_status changes only the caller; queue_work's target is a record to run on; decide's ref is a row waiting on the
 * asker and its note is free text. A write without a row is refused (orchestrator.ts), never treated as naming nobody.
 *
 *   tool        argument              the person
 *   create      fields.assignee       a work item's owner
 *   create      fields.delegate       the delegate who decides for the asker (access)
 *   create      fields.participants   each person a decision names as agreeing (user ids or names)
 *   update      fields.assignee       a work item's new owner
 *   message     target.name           the recipient, unless target.kind is team or channel
 *   call        target.name           the person rung, unless target.kind is team or channel (excluded from meetings today)
 *   set_status, queue_work, decide    nobody
 */
export const PERSON_ARGUMENTS: Readonly<Record<string, readonly PersonArgument[]>> = {
  create: [
    { path: ['fields', 'assignee'], role: 'owner' },
    { path: ['fields', 'delegate'], role: 'delegate' },
    { path: ['fields', 'participants'], role: 'participant', list: true },
  ],
  update: [{ path: ['fields', 'assignee'], role: 'owner' }],
  message: [{ path: ['target', 'name'], role: 'recipient', when: targetIsPerson }],
  call: [{ path: ['target', 'name'], role: 'recipient', when: targetIsPerson }],
  set_status: [],
  queue_work: [],
  decide: [],
};

export interface SaidPerson { said: string; role: PersonRole }

/** The person values a write's arguments carry (as said, not yet resolved). Null when the tool has no row in the table. */
export function peopleSaid(tool: string, args: unknown): SaidPerson[] | null {
  const rows = PERSON_ARGUMENTS[tool];
  if (!rows) return null;
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const out: SaidPerson[] = [];
  for (const row of rows) {
    if (row.when && !row.when(a)) continue;
    let v: unknown = a;
    for (const k of row.path) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
    const values = row.list ? (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]) : (v === undefined || v === null ? [] : [v]);
    // A value of the wrong type in a person argument still counts: it is kept as text and must resolve like any other.
    for (const x of values) { const said = capText(typeof x === 'string' ? x : JSON.stringify(x), 200); if (said) out.push({ said, role: row.role }); }
  }
  return out;
}

const SELF = /^(me|myself|i|my|mine)$/i;
const fold = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** One said person among `people`: an exact user id, an exact display name, or a first name only one of them has; null for none or several. */
function among(said: string, people: readonly RosterEntry[]): RosterEntry | null | 'several' {
  const byId = people.filter((p) => p.userId === said);
  if (byId.length) return byId[0]!;
  const want = fold(said);
  const exact = uniqueBy(people.filter((p) => fold(p.name) === want));
  if (exact) return exact;
  const first = uniqueBy(people.filter((p) => fold(p.name).split(' ')[0] === want));
  return first;
  function uniqueBy(hits: RosterEntry[]): RosterEntry | null | 'several' {
    const ids = new Set(hits.map((h) => h.userId));
    if (ids.size === 1) return hits[0]!;
    return ids.size > 1 ? 'several' : null;
  }
}

export type Resolved =
  | { ok: true; others: Array<RosterEntry & { role: PersonRole }> }
  | { ok: false; why: 'unknown person' | 'several people match' };

/**
 * Resolve every said person to a user id: the asker's own words for themselves, then the call's roster, then the directory (read
 * only when the roster does not settle it). `others` are the people other than the asker, once each, in the order first named.
 */
export async function resolvePeople(said: readonly SaidPerson[], asker: string, roster: readonly RosterEntry[], directory: () => Promise<RosterEntry[]>): Promise<Resolved> {
  const others = new Map<string, RosterEntry & { role: PersonRole }>();
  let dir: RosterEntry[] | null = null;
  for (const s of said) {
    let who: RosterEntry | null | 'several' = SELF.test(s.said.trim()) ? { userId: asker, name: '' } : among(s.said, roster);
    if (who === null) { dir ??= await directory().catch(() => []); who = among(s.said, dir); }
    if (who === 'several') return { ok: false, why: 'several people match' };
    if (!who) return { ok: false, why: 'unknown person' };
    if (who.userId !== asker && !others.has(who.userId)) others.set(who.userId, { ...who, role: s.role });
  }
  return { ok: true, others: [...others.values()] };
}

const ROLE_WORDS: Readonly<Record<PersonRole, (name: string) => string>> = {
  owner: (n) => `owned by ${n}`,
  delegate: (n) => `${n} deciding as delegate`,
  participant: (n) => `with ${n}`,
  recipient: (n) => `to ${n}`,
};

/** The proposal's statement: the write's own summary sentence, and each other person by name in what they are to it. */
export function namedStatement(summary: string, people: ReadonlyArray<{ name: string; role: PersonRole }>, max: number): string {
  const parts = people.map((p) => ROLE_WORDS[p.role](p.name));
  return capText(`${summary}${parts.length ? `, ${parts.join(', ')}` : ''}`, max);
}

/** What Nova's session is told: whose consent it needs, and that it was asked in the chat. */
export function consentStatus(names: readonly string[]): string {
  const whose = names.length <= 1 ? `${names[0] ?? 'someone'}'s` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}'s`;
  return `This needs ${whose} consent; I have asked in the chat.`;
}
