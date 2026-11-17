// The panel's own notice at Accept (docs/interviews-tenant-plan.md decision 5, its last sentence: "Panel members are
// recorded too and see the same notice once, when they accept an assignment").
//
// The reading this module builds:
//   - The panel reads the SAME notice the candidate reads (./notice.ts: its title, its paragraphs, its version), with
//     one sentence of its own that it applies to them too (PANEL_NOTICE_LINE).
//   - It is an acknowledgement, not consent in the candidate's sense. The panel has no three choices and nothing
//     here turns a recording or a transcript off. It is not optional either: accepting a seat (lead or panel) is
//     refused until the person has acknowledged the CURRENT version. An interviewer who will not be recorded
//     declines the assignment; declining never needs the notice.
//   - Once: one row per person and version (panel-notice-store.ts). A new version asks again at the next Accept.
//     Rounds accepted under an earlier version stay accepted; nothing here re-asks them.
//
// The rules are pure; the two reads at the end go through the store inside the tenant's db context.

import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { interviewsStore } from '../store-select.js';
import { INTERVIEWS_TENANT, type Interview, type Seat } from '../types.js';
import { CONSENT_NOTICE, type ConsentNotice } from './notice.js';
import { panelNoticeStore, type PanelNoticeRow } from './panel-notice-store.js';

/** The one sentence the panel reads above the candidate's notice. */
export const PANEL_NOTICE_LINE = 'You are on the panel, so this applies to you too: the call records and transcribes the interviewers as well as the candidate, under the same rules and periods.';

/** The notice as the server answers it to an interviewer: the candidate's own version, title and text. */
export interface PanelNotice { version: string; title: string; text: string; panelLine: string }

/** The current notice, shaped for an Accept that needs it. Paragraphs are separated by a blank line. */
export function panelNoticeOf(notice: ConsentNotice = CONSENT_NOTICE): PanelNotice {
  return { version: notice.version, title: notice.title, text: notice.paragraphs.join('\n\n'), panelLine: PANEL_NOTICE_LINE };
}

/** Has `userId` acknowledged `version` (the current one by default)? Someone else's row never counts. */
export function hasAcknowledged(rows: readonly PanelNoticeRow[], userId: string, version: string = CONSENT_NOTICE.version): boolean {
  return rows.some((r) => r.userId === userId && r.noticeVersion === version);
}

export type AcknowledgementCheck =
  | { ok: true; version: string }
  | { ok: false; reason: 'invalid' | 'not-current'; message: string };

/** An acknowledgement as sent: `{ version }`, which must be the current notice's. Any person named in it is ignored. */
export function checkAcknowledgement(input: unknown, current: string = CONSENT_NOTICE.version): AcknowledgementCheck {
  const v = (input && typeof input === 'object' ? (input as Record<string, unknown>)['version'] : undefined);
  if (typeof v !== 'string' || !v.trim()) return { ok: false, reason: 'invalid', message: 'This page is out of date. Reload it and read the notice again.' };
  if (v !== current) return { ok: false, reason: 'not-current', message: 'The notice has changed since this page loaded. Read the current one, then accept again.' };
  return { ok: true, version: v };
}

/** What one seat of an interview acknowledged (E8). */
export interface SeatNotice {
  userId: string;
  seat: Seat;
  /** When this seat accepted, or null while it has not. */
  acceptedAt: string | null;
  /** The acknowledgement in force for this seat: the latest one made by the time it accepted (or the latest, before then). */
  acknowledged: { version: string; at: string; interviewId: string } | null;
  /** Whether that acknowledgement is of the current notice. */
  current: boolean;
}

/** Each seat of `i` and the notice it acknowledged, from the seat holders' rows. Pure. */
export function seatNotices(i: Pick<Interview, 'leadId' | 'panelIds' | 'acceptances'>, rows: readonly PanelNoticeRow[], current: string = CONSENT_NOTICE.version): SeatNotice[] {
  const seats: Array<{ userId: string; seat: Seat }> = [{ userId: i.leadId, seat: 'lead' }, ...i.panelIds.map((userId) => ({ userId, seat: 'panel' as const }))];
  return seats.map(({ userId, seat }) => {
    const acceptedAt = i.acceptances.find((a) => a.userId === userId && a.seat === seat)?.at ?? null;
    const mine = rows.filter((r) => r.userId === userId && (acceptedAt === null || r.acknowledgedAt <= acceptedAt))
      .sort((a, b) => a.acknowledgedAt.localeCompare(b.acknowledgedAt));
    const last = mine[mine.length - 1];
    return {
      userId, seat, acceptedAt,
      acknowledged: last ? { version: last.noticeVersion, at: last.acknowledgedAt, interviewId: last.interviewId } : null,
      current: last?.noticeVersion === current,
    };
  });
}

/** Has `userId` acknowledged the current notice? Read through the store in the tenant's db context. */
export async function acknowledgedCurrent(userId: string): Promise<boolean> {
  const rows = await runWithDbTenant(INTERVIEWS_TENANT, () => panelNoticeStore().listFor([userId]));
  return hasAcknowledged(rows, userId);
}

/**
 * E8: which notice version each seat of the interview acknowledged, and when. Null when there is no such interview.
 * Nothing about the candidate; staff ids only, as the export's other sections name staff.
 */
export async function exportPanelNotices(interviewId: string): Promise<{ interviewId: string; currentVersion: string; seats: SeatNotice[] } | null> {
  return runWithDbTenant(INTERVIEWS_TENANT, async () => {
    const i = (await interviewsStore().listInterviews()).find((x) => x.id === interviewId);
    if (!i) return null;
    const rows = await panelNoticeStore().listFor([i.leadId, ...i.panelIds]);
    return { interviewId, currentVersion: CONSENT_NOTICE.version, seats: seatNotices(i, rows) };
  });
}
