// The voice navigator's voice settings (G38, docs/voice-navigator-gaps.md):
// GET/PUT /api/voice/settings and what the mint does with them.
//
// Same harness as voice.test.ts: OpenAI is a fake transport, the holds, the
// ledger and the voice rows are the real providers on their offline stores,
// and Cedar decides from the seed files.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true }, aurora: {}, auth: {}, cognito: {} } }));
jest.mock('../../lib/authz.js', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const seeds = path.join(__dirname, '..', '..', '..', 'seeds', 'roles');
  const holds = (tenant: string, role: string, action: string): boolean => {
    const file = path.join(seeds, tenant, `${role}.cedar`);
    if (!fs.existsSync(file)) return false;
    const permits = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').split(/\bpermit\b/).slice(1).map((b: string) => b.split(';')[0]);
    return permits.some((p: string) => p.includes(`OrgIQ::Action::"${action}"`) && p.includes(`principal.tenant == "${tenant}"`));
  };
  return {
    requireSession: () => (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
      (req.session ? next() : res.status(401).json({ error: 'Unauthenticated' })),
    resolveSession: (req: { session?: unknown }) => req.session ?? null,
    isAllowed: jest.fn(async (p: { tenant: string; role: string }, action: string) => holds(p.tenant, p.role, action)),
  };
});

import express from 'express';
import request from '../../test-support/http.js';
import { voiceRouter } from '../voice.js';
import { errorHandler } from '../../lib/async-handler.js';
import { _setVoiceFetch, _setVoiceWebSocket, _resetSidebands } from '../../lib/voice/openai.js';
import { SilentSideband } from '../../test-support/fake-sideband.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { userBudgets } from '../../mock/user-budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { voiceSessionEvents, voiceSessions, voiceToolCalls } from '../../mock/voice-sessions.js';
import { voiceSettingsRows } from '../../mock/voice-settings.js';
import { unfreezeClock } from '../../mock/core/index.js';
import {
  ACCEPTED_UNOFFERED_VOICES, PRESET_VOICES, VOICE_PACES, VOICE_STYLES, parseCustomVoices, resolveVoice, voiceStyleLines,
} from '../../lib/voice/voices.js';

const KEY = 'sk-test-THE_SERVER_SIDE_KEY_never_in_a_body';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 10.0.0.1\r\ns=answer\r\n';
const USER = 'u-vera';
const DESIGNED = { id: 'voice_0123456789abcdef', label: 'Coastal (designed)', description: 'A fictional calm adult voice: unhurried, warm, plain words.' };

let principal: Record<string, unknown> = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
const app = express(); app.use(express.json());
app.use((req, _res, next) => { if (principal) (req as unknown as { session: unknown }).session = principal; next(); });
app.use('/api/voice', voiceRouter); app.use(errorHandler);

interface Call { url: string; init: { method: string; headers: Record<string, string>; body?: string } }
let calls: Call[] = [];

const ENV_KEYS = ['OPENAI_API_KEY', 'MOCK_VOICE', 'VOICE_DELEGATION_MODEL', 'VOICE_VOICE', 'VOICE_CUSTOM_VOICES', 'INSECURE_DEV_MODE', 'VOICE_DAILY_MINUTES'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  resetRateLimits();
  unfreezeClock();
  for (const f of [spendHolds, spendEntries, userBudgets, voiceSessions, voiceToolCalls, voiceSessionEvents, voiceSettingsRows]) f.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['INSECURE_DEV_MODE'] = 'true';
  process.env['OPENAI_API_KEY'] = KEY;
  process.env['VOICE_DELEGATION_MODEL'] = 'gpt-delegate';
  process.env['VOICE_CUSTOM_VOICES'] = JSON.stringify([DESIGNED]);
  principal = { sub: USER, role: 'member', tenant: 'orgiq', grants: {} };
  calls = [];
  _resetSidebands();
  _setVoiceWebSocket(SilentSideband);
  _setVoiceFetch(async (url, init) => {
    calls.push({ url, init });
    return { status: 200, ok: true, text: async () => JSON.stringify({ session: { id: 'sess_live_1' }, transport: { sdp: ANSWER } }) };
  });
  userBudgets.rows().push({ userId: USER, allocatedUsd: 1_000, hardCapUsd: null, note: null, setBy: 'u-release' });
});
afterAll(() => {
  _setVoiceFetch(null);
  _resetSidebands();
  _setVoiceWebSocket(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const get = () => request(app).get('/api/voice/settings');
const put = (body: unknown) => request(app).put('/api/voice/settings').send(body as object);
const mint = () => request(app).post('/api/voice/sessions').send({ sdp: SDP });
const sentSession = () => JSON.parse(calls[0]!.init.body!).session as { instructions: string; audio?: { output: { voice: unknown } } };

describe('GET /api/voice/settings', () => {
  it('answers the defaults and the full catalogue before anything is saved', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ voice: null, style: 'plain', pace: 'normal', default: { voice: 'marin' } });
    const values = res.body.options.voices.map((v: { value: string }) => v.value);
    // The 21 described presets plus marin and cedar, then the designed voice.
    expect(values).toEqual([...PRESET_VOICES.map((v) => v.name), DESIGNED.id]);
    expect(values).toHaveLength(24);
    for (const hidden of ACCEPTED_UNOFFERED_VOICES) expect(values).not.toContain(hidden);
    expect(res.body.options.voices.find((v: { value: string }) => v.value === 'vesper'))
      .toMatchObject({ name: 'vesper', language: 'English', region: 'British', presentation: 'masculine' });
    expect(res.body.options.voices.find((v: { value: string }) => v.value === 'marin'))
      .toMatchObject({ presentation: null, region: null, bestQuality: true });
    expect(res.body.options.voices.find((v: { value: string }) => v.value === DESIGNED.id))
      .toEqual({ value: DESIGNED.id, id: DESIGNED.id, label: DESIGNED.label, language: null, region: null, presentation: null, custom: true });
    expect(res.body.options.styles.map((s: { id: string }) => s.id)).toEqual(['plain', 'north-london', 'rp', 'warm', 'brisk']);
    expect(res.body.options.paces.map((p: { id: string }) => p.id)).toEqual(['brisk', 'normal', 'relaxed']);
  });

  it('names VOICE_VOICE as the default when it is set', async () => {
    process.env['VOICE_VOICE'] = 'cedar';
    expect((await get()).body.default).toEqual({ voice: 'cedar' });
  });

});

describe('PUT /api/voice/settings', () => {
  it('saves a valid choice and GET reads it back', async () => {
    const res = await put({ voice: 'vesper', style: 'rp', pace: 'relaxed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ voice: 'vesper', style: 'rp', pace: 'relaxed' });
    expect((await get()).body).toMatchObject({ voice: 'vesper', style: 'rp', pace: 'relaxed' });
    expect(voiceSettingsRows.rows()).toEqual([expect.objectContaining({ user_sub: USER, voice: 'vesper', style: 'rp', pace: 'relaxed' })]);
  });

  it('a partial PUT changes only the fields it names', async () => {
    await put({ voice: 'willow', style: 'warm' });
    expect((await put({ pace: 'brisk' })).body).toMatchObject({ voice: 'willow', style: 'warm', pace: 'brisk' });
  });

  it('takes preset names in any case and stores them lowercase', async () => {
    expect((await put({ voice: 'MeRiDiAn' })).body.voice).toBe('meridian');
    // An accepted but unoffered Realtime name is accepted too.
    expect((await put({ voice: 'Alloy' })).body.voice).toBe('alloy');
  });

  it('takes an allowlisted designed voice, exactly as written', async () => {
    expect((await put({ voice: DESIGNED.id })).body.voice).toBe(DESIGNED.id);
  });

  it('refuses what the catalogue does not offer, naming the field, and saves nothing', async () => {
    for (const [body, field] of [
      [{ voice: 'onyx' }, 'voice'], [{ voice: 'nova' }, 'voice'], [{ voice: 'voice_notonthelist00' }, 'voice'], [{ voice: 42 }, 'voice'],
      [{ style: 'pirate' }, 'style'], [{ style: 3 }, 'style'], [{ pace: 'fast' }, 'pace'],
    ] as const) {
      const res = await put(body);
      expect([JSON.stringify(body), res.status, res.body.field]).toEqual([JSON.stringify(body), 400, field]);
    }
    expect(voiceSettingsRows.rows()).toEqual([]);
  });

  it('null puts a field back to its default', async () => {
    await put({ voice: 'stone', style: 'brisk', pace: 'brisk' });
    expect((await put({ voice: null, style: null, pace: null })).body).toMatchObject({ voice: null, style: 'plain', pace: 'normal' });
    expect((await get()).body).toMatchObject({ voice: null, style: 'plain', pace: 'normal' });
  });

  it('settings are per person', async () => {
    await put({ voice: 'gleam' });
    principal = { sub: 'u-other', role: 'member', tenant: 'orgiq', grants: {} };
    expect((await get()).body.voice).toBeNull();
  });
});

describe('the mint applies the settings', () => {
  it('no settings: no voice is sent and the instructions carry no style line', async () => {
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ voice: null, style: 'plain' });
    expect(sentSession().audio).toBeUndefined();
    expect(sentSession().instructions).not.toMatch(/Speaking style|Speak quickly|Speak slowly|Your voice, as it was designed/);
  });

  it('a preset with a style and a pace: the voice is sent and both lines end the instructions', async () => {
    await put({ voice: 'Vesper', style: 'north-london', pace: 'relaxed' });
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ voice: 'vesper', style: 'north-london' });
    expect(sentSession().audio).toEqual({ output: { voice: 'vesper' } });
    const lines = sentSession().instructions.split('\n');
    expect(lines.slice(-2)).toEqual([VOICE_STYLES.find((s) => s.id === 'north-london')!.line, 'Speak slowly and deliberately.']);
    const minted = voiceSessionEvents.rows().find((e) => e.session_id === res.body.sessionId && e.kind === 'minted')!;
    expect(minted.data).toMatchObject({ voice: 'vesper', style: 'north-london', pace: 'relaxed' });
    expect(voiceSessions.rows()[0]).toMatchObject({ voice: 'vesper' });
  });

  it('a designed voice is sent as { id } and its description is repeated in the instructions', async () => {
    await put({ voice: DESIGNED.id, style: 'warm' });
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body.voice).toBe(DESIGNED.id);
    expect(sentSession().audio).toEqual({ output: { voice: { id: DESIGNED.id } } });
    const lines = sentSession().instructions.split('\n');
    expect(lines.slice(-2)).toEqual([`Your voice, as it was designed: ${DESIGNED.description}`, 'Speaking style: warm and unhurried.']);
  });

  it('a designed voice the operator removed falls back to VOICE_VOICE, without its description', async () => {
    await put({ voice: DESIGNED.id });
    process.env['VOICE_CUSTOM_VOICES'] = '[]';
    process.env['VOICE_VOICE'] = 'cedar';
    const res = await mint();
    expect(res.body.voice).toBe('cedar');
    expect(sentSession().audio).toEqual({ output: { voice: 'cedar' } });
    expect(sentSession().instructions).not.toContain(DESIGNED.description);
  });
});

describe('the catalogue', () => {
  it('resolveVoice: the choice, else VOICE_VOICE, else the provider default (null)', () => {
    const cfg = { voice: null, customVoices: [] };
    expect(resolveVoice({ voice: 'Willow' }, cfg)).toBe('willow');
    expect(resolveVoice({ voice: null }, { ...cfg, voice: 'cedar' })).toBe('cedar');
    expect(resolveVoice({ voice: null }, cfg)).toBeNull();
    expect(resolveVoice({ voice: 'onyx' }, cfg)).toBeNull();
  });

  it('voiceStyleLines: plain and normal add nothing', () => {
    expect(voiceStyleLines({ style: 'plain', pace: 'normal' })).toEqual([]);
    expect(voiceStyleLines({ style: 'rp', pace: 'brisk' })).toEqual(['Speaking style: Received Pronunciation, crisp and clipped.', 'Speak quickly.']);
  });

  it('VOICE_CUSTOM_VOICES skips malformed entries and malformed JSON', () => {
    expect(parseCustomVoices('not json')).toEqual([]);
    expect(parseCustomVoices('{"id":"voice_abcdef"}')).toEqual([]);
    expect(parseCustomVoices(JSON.stringify([
      DESIGNED, { id: 'marin', label: 'x', description: 'y' }, { id: 'voice_nolabel1', description: 'y' }, { id: 'voice_nodesc01', label: 'x' },
    ]))).toEqual([DESIGNED]);
  });

  it('no style or pace text names a person: its only proper nouns are the allowed place names', () => {
    // Capitalised words that are ordinary words at the start of a line or a
    // label, or the register's own name; the place names are London and Highgate.
    const allowed = new Set([
      'Speaking', 'Speak', 'The', 'Plain', 'North', 'London', 'Highgate', 'Gen', 'Z', 'Received', 'Pronunciation',
      'Crisp', 'Warm', 'Brisk', 'Clipped', 'Young', 'Quick', 'Normal', 'Slow',
    ]);
    const texts = [
      ...VOICE_STYLES.flatMap((s) => [s.label, s.hint, s.line ?? '']),
      ...VOICE_PACES.flatMap((p) => [p.label, p.line ?? '']),
    ];
    const capitalised = texts.flatMap((t) => t.match(/\b[A-Z][A-Za-z]*\b/g) ?? []);
    expect(capitalised.filter((w) => !allowed.has(w))).toEqual([]);
  });
});
