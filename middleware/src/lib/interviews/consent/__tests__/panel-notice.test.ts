// The panel's notice (lib/interviews/consent/panel-notice*.ts; docs/interviews-tenant-plan.md decision 5, its last
// sentence): the two stores behave the same, the rules, the seed, and the E8 export.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { MemoryPanelNoticeStore, setPanelNoticeStore, type PanelNoticeRow, type PanelNoticeStore } from '../panel-notice-store.js';
import { GET_PANEL_NOTICE_SQL, INSERT_PANEL_NOTICE_SQL, LIST_PANEL_NOTICES_SQL, PANEL_NOTICE_STATEMENTS, SqlPanelNoticeStore } from '../panel-notice-store-sql.js';
import type { SqlExec } from '../../store-sql.js';
import { acknowledgedCurrent, checkAcknowledgement, exportPanelNotices, hasAcknowledged, panelNoticeOf, seatNotices } from '../panel-notice.js';
import { CONSENT_NOTICE } from '../notice.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { EARLIER_NOTICE_VERSION, interviewPanelNoticesFixture } from '../../../../mock/interviews-panel-notices.js';
import { interviewsFixture } from '../../../../mock/interviews.js';

const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');
const param = (params: SqlParameter[] | undefined, name: string): string => String(params?.find((x) => x.name === name)?.value?.stringValue ?? '');

/** interview_panel_notices as the Data API would keep and answer it, keyed on (user_id, notice_version). */
function noticesTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  return async (sql, params) => {
    const s = (n: string) => param(params, n);
    if (sql === LIST_PANEL_NOTICES_SQL) {
      const ids = JSON.parse(s('user_ids')) as string[];
      return out(table.filter((r) => ids.includes(String(r['user_id']))).sort((a, b) => String(a['acknowledged_at']).localeCompare(String(b['acknowledged_at']))));
    }
    if (sql === GET_PANEL_NOTICE_SQL) return out(table.filter((r) => r['user_id'] === s('user_id') && r['notice_version'] === s('notice_version')));
    if (sql === INSERT_PANEL_NOTICE_SQL) {
      if (table.some((r) => r['user_id'] === s('user_id') && r['notice_version'] === s('notice_version'))) return [];
      const row = { user_id: s('user_id'), notice_version: s('notice_version'), acknowledged_at: ts(s('acknowledged_at')), interview_id: s('interview_id') };
      table.push(row);
      return out([row]);
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
}

const T = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const ack = (userId: string, version: string, minute: number, interviewId = 'iv-x'): PanelNoticeRow => ({ userId, noticeVersion: version, acknowledgedAt: T(minute), interviewId });

afterEach(() => { fixtureRegistry.resetAll('default'); setPanelNoticeStore(null); });

describe.each([
  ['memory', () => new MemoryPanelNoticeStore() as PanelNoticeStore],
  ['sql', () => new SqlPanelNoticeStore(noticesTableExec()) as PanelNoticeStore],
])('the %s panel notice store', (name, make) => {
  let store: PanelNoticeStore;
  beforeEach(() => {
    store = make();
    // The memory store starts from the seed; empty it so both start alike.
    if (name === 'memory') interviewPanelNoticesFixture.rows().splice(0);
  });

  it('keeps an acknowledgement and lists a person\'s, oldest first, and nobody else\'s', async () => {
    expect(await store.listFor(['u-a'])).toEqual([]);
    expect(await store.acknowledge(ack('u-a', 'v2', 5))).toEqual({ created: true, row: ack('u-a', 'v2', 5) });
    await store.acknowledge(ack('u-a', 'v1', 1));
    await store.acknowledge(ack('u-b', 'v2', 3));
    expect((await store.listFor(['u-a'])).map((r) => r.noticeVersion)).toEqual(['v1', 'v2']);
    expect((await store.listFor(['u-a', 'u-b'])).map((r) => r.userId)).toEqual(['u-a', 'u-b', 'u-a']);
    expect(await store.listFor([])).toEqual([]);
  });

  it('once per person and version: a second acknowledgement keeps the first time and interview', async () => {
    await store.acknowledge(ack('u-a', 'v2', 1, 'iv-first'));
    const again = await store.acknowledge(ack('u-a', 'v2', 9, 'iv-second'));
    expect(again).toEqual({ created: false, row: ack('u-a', 'v2', 1, 'iv-first') });
    expect(await store.listFor(['u-a'])).toHaveLength(1);
  });
});

describe('the rules', () => {
  it('the notice is the candidate\'s own, with the panel\'s one line', () => {
    const n = panelNoticeOf();
    expect(n).toMatchObject({ version: CONSENT_NOTICE.version, title: CONSENT_NOTICE.title });
    expect(n.text.split('\n\n')).toEqual(CONSENT_NOTICE.paragraphs);
    expect(n.panelLine).toMatch(/applies to you too/);
  });

  it('only the person\'s own row on the current version counts', () => {
    const rows = [ack('u-a', 'old', 1), ack('u-b', CONSENT_NOTICE.version, 2)];
    expect(hasAcknowledged(rows, 'u-a')).toBe(false);
    expect(hasAcknowledged(rows, 'u-b')).toBe(true);
    expect(hasAcknowledged(rows, 'u-a', 'old')).toBe(true);
  });

  it('an acknowledgement names the current version; anything else is refused, any person in it ignored', () => {
    expect(checkAcknowledgement({ version: CONSENT_NOTICE.version, userId: 'u-x' })).toEqual({ ok: true, version: CONSENT_NOTICE.version });
    expect(checkAcknowledgement({ version: 'old' })).toMatchObject({ ok: false, reason: 'not-current' });
    expect(checkAcknowledgement({})).toMatchObject({ ok: false, reason: 'invalid' });
    expect(checkAcknowledgement(null)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('each seat\'s acknowledgement is the one in force when it accepted', () => {
    const i = { leadId: 'u-a', panelIds: ['u-b', 'u-c'], acceptances: [{ userId: 'u-a', seat: 'lead' as const, at: T(10) }] };
    const rows = [ack('u-a', 'old', 1), ack('u-a', CONSENT_NOTICE.version, 20), ack('u-b', CONSENT_NOTICE.version, 5)];
    expect(seatNotices(i, rows)).toEqual([
      { userId: 'u-a', seat: 'lead', acceptedAt: T(10), acknowledged: { version: 'old', at: T(1), interviewId: 'iv-x' }, current: false },
      { userId: 'u-b', seat: 'panel', acceptedAt: null, acknowledged: { version: CONSENT_NOTICE.version, at: T(5), interviewId: 'iv-x' }, current: true },
      { userId: 'u-c', seat: 'panel', acceptedAt: null, acknowledged: null, current: false },
    ]);
  });
});

describe('the seed', () => {
  it('Wen read the current notice, Hugo an earlier one before any round he accepted', () => {
    const rows = interviewPanelNoticesFixture.rows('default');
    expect(rows.map((r) => [r.userId, r.noticeVersion])).toEqual([['u-hugo', EARLIER_NOTICE_VERSION], ['u-wen', CONSENT_NOTICE.version]]);
    expect(EARLIER_NOTICE_VERSION).not.toBe(CONSENT_NOTICE.version);
    for (const i of interviewsFixture.rows('default')) {
      for (const a of i.acceptances) {
        const mine = rows.find((r) => r.userId === a.userId)!;
        expect([i.id, Date.parse(mine.acknowledgedAt) <= Date.parse(a.at)]).toEqual([i.id, true]);
      }
    }
    // Hugo still has a round to accept, so the demo shows the notice.
    expect(interviewsFixture.rows('default').some((i) => i.leadId === 'u-hugo' && i.state === 'assigned')).toBe(true);
  });

  it('acknowledgedCurrent reads the store', async () => {
    expect(await acknowledgedCurrent('u-wen')).toBe(true);
    expect(await acknowledgedCurrent('u-hugo')).toBe(false);
  });
});

describe('exportPanelNotices (E8)', () => {
  it('each seat of the interview, with the version it acknowledged and when; null for an unknown interview', async () => {
    const out = await exportPanelNotices('iv-nadia-leadership');
    expect(out).toMatchObject({ interviewId: 'iv-nadia-leadership', currentVersion: CONSENT_NOTICE.version });
    expect(out!.seats.map((s) => [s.userId, s.seat, s.acknowledged?.version, s.current])).toEqual([
      ['u-wen', 'lead', CONSENT_NOTICE.version, true],
      ['u-hugo', 'panel', EARLIER_NOTICE_VERSION, false],
    ]);
    expect(await exportPanelNotices('iv-nobody')).toBeNull();
  });
});

describe('every panel notice statement matches schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const table = /CREATE TABLE IF NOT EXISTS interview_panel_notices \(([\s\S]*?)\n\);/.exec(ddl)?.[1] ?? '';
  const columns = new Set([...table.matchAll(/^\s+([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]));

  it('declares the table keyed on the person and version, and every column a statement names', () => {
    expect([...columns].sort()).toEqual(['acknowledged_at', 'interview_id', 'notice_version', 'user_id']);
    expect(table).toMatch(/PRIMARY KEY \(user_id, notice_version\)/);
    for (const sql of PANEL_NOTICE_STATEMENTS) {
      const named = [...sql.replace(/:[a-z_]+/g, '').matchAll(/\b([a-z]+(?:_[a-z]+)+)\b/g)].map((m) => m[1]!)
        .filter((w) => !['interview_panel_notices', 'jsonb_array_elements_text'].includes(w));
      for (const col of named) expect([col, columns.has(col)]).toEqual([col, true]);
    }
  });
});
