// Hardening lane H2, rows I2.5 and I2.6 (O-083): D2 (POST /api/realtime/recording-decision) when a store it reads fails. The
// contract is fail closed: platform-api records only on a 200 with a yes, and a 500 is not an answer this route may give for a
// seated caller. Same mounting as realtime-lobby-access-interviews.test.ts.
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

import type { ConsentStore } from '../../lib/interviews/consent/store.js';

describe('O-083: D2 with a store down refuses, never a 500', () => {
  const down = () => { throw new Error('consent store unavailable'); };
  it('the consent store failing: the lead and the admitted candidate get the refusal (403, nothing records)', async () => {
    setConsent({ recording: true, transcription: true, milo: true });
    const failing = new MemoryConsentStore() as unknown as ConsentStore;
    (failing as { getConsent: unknown }).getConsent = jest.fn(async () => down());
    setConsentStore(failing);
    for (const token of [await staffToken('u-wen'), await guestToken(IV)]) {
      const res = await ask('recording-decision', token);
      expect([res.status, res.body]).toEqual([403, REFUSED]);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(failing.getConsent).toHaveBeenCalled();
  });

  it('the interviews store failing after the seat is decided: the refusal too', async () => {
    setConsent({ recording: true, transcription: true, milo: true });
    const lead = await staffToken('u-wen');
    expect((await ask('recording-decision', lead)).status).toBe(200);
    const store = new MemoryInterviewsStore();
    const real = store.listInterviews.bind(store);
    let reads = 0;
    let failAt = Infinity;
    jest.spyOn(store, 'listInterviews').mockImplementation(async () => { reads += 1; if (reads === failAt) down(); return real(); });
    setInterviewsStore(store);
    expect((await ask('recording-decision', lead)).status).toBe(200);
    // The seat check reads first; the decision's own read of the interview is the last one: that is the one that fails.
    failAt = reads * 2;
    const res = await ask('recording-decision', lead);
    expect([res.status, res.body]).toEqual([403, REFUSED]);
  });
});
