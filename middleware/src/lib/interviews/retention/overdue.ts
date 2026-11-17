// A late deletion (docs/interviews-tenant-plan.md decision 17; round 5's notice gate): a row of the deletion log that is not
// done by its `dueBy` (the request's 30 days by default, or a period's sweep that is still unfinished) is overdue.
//
//   isOverdue / doneLate    the two facts the deletions read puts on each row (routes/interviews/retention.ts).
//   ringOverdue             the opening's recruiter gets ONE bell when a row first passes its date while still open, from
//                           the hourly retention sweep (service.ts). The bell names the opening and says a deletion is late,
//                           never the candidate, no time, no reason; it opens the candidate's profile, where the Deletions
//                           table says what is left.
//
// One bell per row and recruiter, remembered twice and with no table: the bell's id is derived from the row and the
// recruiter (`interview-deletion-overdue:<hash of the row id>:<recruiter>`), and before ringing the recruiter's inbox is
// read for that id when the gateway's inbox can be read (social-notify.ts `notificationInbox`); the rows already rung are
// also kept in memory for this process. So a restart rings again only where the inbox cannot be read, at most once more
// per restart.
import { notificationInbox, notify } from '../../social-notify.js';
import type { InterviewsWorld } from '../types.js';
import type { DeletionRow } from './store.js';

export const OVERDUE_BELL_KIND = 'interview-deletion-overdue';

export const isOverdue = (row: Pick<DeletionRow, 'doneAt' | 'dueBy'>, nowMs: number): boolean =>
  row.doneAt === null && Date.parse(row.dueBy) < nowMs;

export const doneLate = (row: Pick<DeletionRow, 'doneAt' | 'dueBy'>): boolean =>
  row.doneAt !== null && Date.parse(row.doneAt) > Date.parse(row.dueBy);

/** Overdue rows first, then by the date they are due, earliest first (the sweep's order for the rows it retries). */
export function overdueFirst(rows: readonly DeletionRow[], nowMs: number): DeletionRow[] {
  return [...rows].sort((a, b) => Number(isOverdue(b, nowMs)) - Number(isOverdue(a, nowMs)) || Date.parse(a.dueBy) - Date.parse(b.dueBy) || a.id.localeCompare(b.id));
}

/** A key for the row that does not spell out its id. */
function rowKey(id: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < id.length; k++) { h ^= id.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export const overdueBellId = (rowId: string, recruiterId: string): string => `${OVERDUE_BELL_KIND}:${rowKey(rowId)}:${recruiterId}`;

/** Each recruiter of the openings the row's interviews belong to, with the title of one of their openings. */
export function recruitersOf(row: Pick<DeletionRow, 'interviewIds'>, world: InterviewsWorld): Array<{ recruiterId: string; openingTitle: string; more: number }> {
  const byRecruiter = new Map<string, string[]>();
  for (const id of row.interviewIds) {
    const iv = world.interviews.find((i) => i.id === id);
    const app = iv && world.applications.find((a) => a.id === iv.applicationId);
    const opening = app && world.openings.find((o) => o.id === app.openingId);
    if (!opening) continue;
    const titles = byRecruiter.get(opening.recruiterId) ?? [];
    if (!titles.includes(opening.title)) titles.push(opening.title);
    byRecruiter.set(opening.recruiterId, titles);
  }
  return [...byRecruiter].map(([recruiterId, titles]) => ({ recruiterId, openingTitle: titles[0]!, more: titles.length - 1 }));
}

export interface OverdueDeps {
  notify: typeof notify;
  inbox: typeof notificationInbox;
}
const defaults: OverdueDeps = { notify, inbox: notificationInbox };

const rungThisProcess = new Set<string>();

const short = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Ring the recruiters of every row in `rows` that is overdue now and has not been rung. Returns how many bells went. Never throws. */
export async function ringOverdue(rows: readonly DeletionRow[], world: InterviewsWorld, nowMs: number, deps: Partial<OverdueDeps> = {}, rung: Set<string> = rungThisProcess): Promise<number> {
  const d = { ...defaults, ...deps };
  let sent = 0;
  for (const row of rows) {
    if (!isOverdue(row, nowMs)) continue;
    for (const { recruiterId, openingTitle, more } of recruitersOf(row, world)) {
      const id = overdueBellId(row.id, recruiterId);
      if (rung.has(id)) continue;
      rung.add(id); // claimed before the awaits, so an overlapping sweep skips it
      try {
        const inbox = d.inbox();
        if (inbox && (await inbox.listForUser(recruiterId)).some((item) => item.id === id)) continue;
        const where = more > 0 ? `${short(openingTitle)} and ${more === 1 ? 'one other opening' : `${more} other openings`}` : short(openingTitle);
        const to = await d.notify([recruiterId], {
          id,
          type: 'system',
          title: `A candidate's deletion on ${where} is late`,
          body: 'It was not finished by the date it was due. Open the profile to see what is left and ask for the deletion again.',
          payload: { tenant: 'interviews', kind: OVERDUE_BELL_KIND, audience: 'recruiter' },
          action: { label: 'Open the profile', href: `/interviews/candidates/${encodeURIComponent(row.candidateId)}` },
        });
        sent += to.length;
        if (!to.length) rung.delete(id); // nobody reached (no bell service yet, or no recruiter holding the role): try again next sweep
      } catch (err) {
        rung.delete(id); // the next sweep tries again
        console.warn(`[interviews] late-deletion bell not sent: ${(err as Error).name}`);
      }
    }
  }
  return sent;
}
