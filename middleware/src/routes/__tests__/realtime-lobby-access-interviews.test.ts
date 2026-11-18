// POST /api/realtime/recording-decision and /recording-access (routes/realtime-lobby-access.ts; contracts D2 and D3; rows I2.5,
// I2.6): platform-api's two questions about an interview's call, asked with the caller's own realtime token (staff or guest).
//
//   D2  a bearer seated in the interview's call now gets { record, transcribe, reason } from the candidate's stored answers;
//       everyone else, and every other lobby, gets 403 { record: false, transcribe: false }.
//   D3  the panel side (lead, panel, recruiter, the opening's hiring manager) gets { allowed: true } whatever the state; a
//       guest, the admin, another round's interviewer, another opening's hiring manager and a Work session get 403.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn(async () => []) }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../lib/page-resources.js', () => ({ pageResourceVisible: jest.fn(async () => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import type { Session } from '../../lib/session.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../mock/interviews.js';
import { interviewConsentsFixture } from '../../mock/interviews-consents.js';
import { MemoryInterviewsStore } from '../../lib/interviews/store.js';
import { setInterviewsStore } from '../../lib/interviews/store-select.js';
import { MemoryConsentStore, setConsentStore } from '../../lib/interviews/consent/store.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { applyAdmission } from '../../lib/interviews/invite/admission.js';
import { loadGuestSession } from '../../lib/interviews/invite/guest.js';
import { mintGuestRealtimeToken } from '../../lib/interviews/invite/realtime.js';
import { MemoryInviteStore, setInviteStore } from '../../lib/interviews/invite/store.js';
import { recordingAccessAllowed, recordingDecision, usableAnswers } from '../../lib/interviews/recording-rules.js';
import { realtimeLobbyAccessRouter } from '../realtime-lobby-access.js';

const SECRET = 'recording-decision-test-secret';
const IV = 'iv-n5z9f2cq';   // Wen leads, Hugo on the panel, accepted, op-em (Greta recruits, Amara hires)
const OTHER = 'iv-c3k8w2ma';     // Wen leads, nobody else: Hugo is another round's interviewer here
const LOBBY = `interviews:interview:${IV}`;
const app = express().use(express.json()).use('/api/realtime', realtimeLobbyAccessRouter);

const USERS: Record<string, { tenant: string; role: string }> = {
  'u-wen': { tenant: 'interviews', role: 'interviewer' },
  'u-hugo': { tenant: 'interviews', role: 'interviewer' },
  'u-greta': { tenant: 'interviews', role: 'recruiter' },
  'u-amara': { tenant: 'interviews', role: 'hiring-manager' },
  'u-root': { tenant: 'interviews', role: 'admin' },
  'u-alice': { tenant: 'orgiq', role: 'member' },
};
const staffToken = async (sub: string) => {
  const { tenant, role } = USERS[sub]!;
  const session = { sub, name: sub, role, tenant, grants: { [tenant]: [role] }, epoch: 0, iat: Math.floor(Date.now() / 1000) } as Session;
  return (await signRealtimeToken(realtimeClaims(session), SECRET)).token;
};
const ask = (path: 'recording-decision' | 'recording-access', token: string | null, lobbyName: unknown = LOBBY) => {
  const r = request(app).post(`/api/realtime/${path}`);
  return (token ? r.set('authorization', `Bearer ${token}`) : r).send({ lobbyName } as object);
};

const now = new Date().toISOString();
function setConsent(a: { recording: boolean; transcription: boolean; milo: boolean } | null, notice = CONSENT_NOTICE.version, id = IV): void {
  const rows = interviewConsentsFixture.rows();
  const at = rows.findIndex((r) => r.interviewId === id);
  if (at >= 0) rows.splice(at, 1);
  if (!a) return;
  rows.push({ interviewId: id, noticeVersion: notice, recording: a.recording, recordingAt: now, transcription: a.transcription, transcriptionAt: now,
    milo: a.transcription && a.milo, miloAt: now, answeredAt: now, changedAt: now, history: [], revision: 1 });
}
const setState = (state: string, id = IV) => { interviewsFixture.rows().find((i) => i.id === id)!.state = state as never; };

const ENV = ['INTERVIEWS_GUEST_REALTIME', 'INTERVIEWS_ENABLED', 'REALTIME_JWT_SECRET', 'INSECURE_DEV_MODE'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let invites: MemoryInviteStore;

async function guestToken(interviewId: string, admitted = true): Promise<string> {
  const issued = await invites.issueInvite({ interviewId, tokenHash: `${interviewId}`.padEnd(64, 'f').slice(0, 64), issuedBy: 'u-greta', issuedAt: now,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  await invites.recordOpening(issued.id, now, 'a'.repeat(64));
  if (admitted) {
    await applyAdmission(issued.id, { kind: 'knock' });
    expect(await applyAdmission(issued.id, { kind: 'decide', admit: true })).toMatchObject({ ok: true });
  }
  const loaded = await loadGuestSession(issued.id, () => true, '');
  return (await mintGuestRealtimeToken(loaded!.principal, SECRET)).token;
}

beforeEach(() => {
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  process.env['INTERVIEWS_ENABLED'] = 'true';
  process.env['INTERVIEWS_GUEST_REALTIME'] = 'true';
  delete process.env['INSECURE_DEV_MODE']; // no dev secret: a missing secret is 503
  fixtureRegistry.resetAll('default');
  setInterviewsStore(new MemoryInterviewsStore());
  setConsentStore(new MemoryConsentStore());
  invites = new MemoryInviteStore();
  setInviteStore(invites);
  jest.mocked(getUser).mockImplementation(async (id) => {
    const u = USERS[id];
    return u ? ({ id, displayName: id, epoch: 0, email: null, personId: null, grants: { [u.tenant]: [u.role] } } as UserInfo) : null;
  });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  setInterviewsStore(null); setConsentStore(null); setInviteStore(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const REFUSED = { record: false, transcribe: false };
const yn = [true, false] as const;
const COMBOS = yn.flatMap((recording) => yn.flatMap((transcription) => yn.map((milo) => ({ recording, transcription, milo }))));

describe('the rules, pure', () => {
  it('D2: no seat is refused; a call not open, no answers and a declined recording each say so', () => {
    expect(recordingDecision({ seated: false, state: 'live', answers: COMBOS[0]! })).toEqual({ status: 403, body: REFUSED });
    expect(recordingDecision({ seated: true, state: 'ended', answers: COMBOS[0]! }).body).toEqual({ ...REFUSED, reason: 'interview-not-open', decisionVersion: 0 });
    expect(recordingDecision({ seated: true, state: 'live', answers: null }).body).toEqual({ ...REFUSED, reason: 'interview-consent-missing', decisionVersion: 0 });
    for (const a of COMBOS) {
      expect(recordingDecision({ seated: true, state: 'live', answers: a }).body).toEqual({
        record: a.recording, transcribe: a.transcription, reason: a.recording ? 'interview-consented' : 'interview-recording-declined', decisionVersion: 0 });
    }
    expect(recordingDecision({ seated: true, state: 'live', answers: COMBOS[0]!, version: 7 }).body).toMatchObject({ decisionVersion: 7 });
  });

  it('usable answers: the current notice before the call, whatever notice once it has started', () => {
    const rec = { noticeVersion: 'old', recording: true, transcription: true, milo: true };
    expect(usableAnswers(rec, 'ready')).toBeNull();
    expect(usableAnswers(rec, 'live')).toEqual({ recording: true, transcription: true, milo: true });
    expect(usableAnswers({ ...rec, noticeVersion: CONSENT_NOTICE.version, transcription: false }, 'ready')).toEqual({ recording: true, transcription: false, milo: false });
    expect(usableAnswers(null, 'live')).toBeNull();
  });

  it('D3: the panel side in the tenant only; never a guest, never the admin', () => {
    const yes = { flagOn: true, guest: false, tenant: 'interviews', role: 'recruiter', mayView: true, panelSide: true };
    expect(recordingAccessAllowed(yes)).toBe(true);
    for (const over of [{ flagOn: false }, { guest: true }, { tenant: 'orgiq' }, { role: 'admin' }, { mayView: false }, { panelSide: false }]) {
      expect([over, recordingAccessAllowed({ ...yes, ...over })]).toEqual([over, false]);
    }
  });
});

describe('POST /recording-decision (D2)', () => {
  it.each(COMBOS)('the lead and the admitted candidate get the same answer for %j', async (a) => {
    setConsent(a);
    const want = { record: a.recording, transcribe: a.transcription, reason: a.recording ? 'interview-consented' : 'interview-recording-declined', decisionVersion: 1 };
    for (const token of [await staffToken('u-wen'), await staffToken('u-hugo'), await guestToken(IV)]) {
      const res = await ask('recording-decision', token);
      expect([res.status, res.body]).toEqual([200, want]);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('with nothing answered, or answers under an older notice before the call, nothing records', async () => {
    const lead = await staffToken('u-wen');
    setConsent(null);
    expect((await ask('recording-decision', lead)).body).toEqual({ ...REFUSED, reason: 'interview-consent-missing', decisionVersion: 0 });
    setConsent({ recording: true, transcription: true, milo: true }, '2020-01-01.1');
    expect((await ask('recording-decision', lead)).body).toEqual({ ...REFUSED, reason: 'interview-consent-missing', decisionVersion: 1 });
    setState('live');
    expect((await ask('recording-decision', lead)).body).toEqual({ record: true, transcribe: true, reason: 'interview-consented', decisionVersion: 1 });
  });

  it('refuses everyone without a seat: the recruiter, the hiring manager, the admin, another round\'s interviewer, a Work session', async () => {
    setConsent({ recording: true, transcription: true, milo: true });
    for (const who of ['u-greta', 'u-amara', 'u-root', 'u-alice']) {
      const res = await ask('recording-decision', await staffToken(who));
      expect([who, res.status, res.body]).toEqual([who, 403, REFUSED]);
    }
    setConsent({ recording: true, transcription: true, milo: true }, CONSENT_NOTICE.version, OTHER);
    expect((await ask('recording-decision', await staffToken('u-hugo'), `interviews:interview:${OTHER}`)).status).toBe(403);
  });

  it('refuses a guest of another interview, a waiting guest, and its own guest on another lobby', async () => {
    setConsent({ recording: true, transcription: true, milo: true });
    expect((await ask('recording-decision', await guestToken(OTHER))).status).toBe(403);
    expect((await ask('recording-decision', await guestToken(IV, false))).status).toBe(403);
    expect((await ask('recording-decision', await guestToken(IV), 'orgiq:initiative:p-1')).body).toEqual(REFUSED);
  });

  it('refuses every other lobby family, and an interview no longer in a call state', async () => {
    setConsent({ recording: true, transcription: true, milo: true });
    const lead = await staffToken('u-wen');
    for (const lobby of ['orgiq:initiative:p-1', 'social:ch:general', `interviews:pad:${IV}`, `${LOBBY}~breakout~r1`]) {
      expect([lobby, (await ask('recording-decision', lead, lobby)).status]).toEqual([lobby, 403]);
    }
    setState('ended');
    expect((await ask('recording-decision', lead)).status).toBe(403);
  });

  it('401 without or with a bad token, 400 without a lobby, 503 without the secret', async () => {
    expect((await ask('recording-decision', null)).status).toBe(401);
    expect((await ask('recording-decision', 'not-a-token')).status).toBe(401);
    expect((await ask('recording-decision', await staffToken('u-wen'), '')).status).toBe(400);
    const lead = await staffToken('u-wen');
    delete process.env['REALTIME_JWT_SECRET'];
    expect((await ask('recording-decision', lead)).status).toBe(503);
  });
});

describe('POST /recording-access (D3)', () => {
  it('the lead, the panel, the recruiter and the opening\'s hiring manager, whatever the state', async () => {
    for (const state of ['accepted', 'live', 'ended', 'scored']) {
      setState(state);
      for (const who of ['u-wen', 'u-hugo', 'u-greta', 'u-amara']) {
        const res = await ask('recording-access', await staffToken(who));
        expect([state, who, res.status, res.body]).toEqual([state, who, 200, { allowed: true }]);
      }
    }
  });

  it('never a guest (its own interview\'s, admitted, or another\'s), the admin, a Work session or another round\'s interviewer', async () => {
    for (const token of [await guestToken(IV), await guestToken(OTHER), await staffToken('u-root'), await staffToken('u-alice')]) {
      expect(await ask('recording-access', token).then((r) => [r.status, r.body])).toEqual([403, { allowed: false }]);
    }
    expect((await ask('recording-access', await staffToken('u-hugo'), `interviews:interview:${OTHER}`)).status).toBe(403);
  });

  it('another opening\'s hiring manager is refused', async () => {
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-em')!.hiringManagerId = 'u-otto';
    expect((await ask('recording-access', await staffToken('u-amara'))).status).toBe(403);
  });

  it('refuses every other lobby family, a bad token and a missing secret', async () => {
    const greta = await staffToken('u-greta');
    for (const lobby of ['orgiq:initiative:p-1', `interviews:pad:${IV}`, 'social:ch:general']) {
      expect((await ask('recording-access', greta, lobby)).status).toBe(403);
    }
    expect((await ask('recording-access', 'bad')).status).toBe(401);
    delete process.env['REALTIME_JWT_SECRET'];
    expect((await ask('recording-access', greta)).status).toBe(503);
  });

  it('refuses everything while the tenant is off', async () => {
    const greta = await staffToken('u-greta');
    const lead = await staffToken('u-wen');
    setConsent({ recording: true, transcription: true, milo: true });
    delete process.env['INTERVIEWS_ENABLED'];
    expect((await ask('recording-access', greta)).status).toBe(403);
    expect((await ask('recording-decision', lead)).status).toBe(403);
  });
});
