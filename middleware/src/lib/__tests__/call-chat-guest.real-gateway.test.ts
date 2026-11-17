// What a guest reads of an interview call's chat, against the REAL gateway (OWED O-133; contract E9, widened by decision 9):
// the guest's huddle join history and its live frames carry, of Milo's messages, only the questions the lead approved and
// Milo's approved answers to the candidate's own two fixed requests (the answer mark), and nothing else of Milo's. The
// in-process rule is call-chat-guest.test.ts; this is the same rule over a socket to a running gateway.
//
// Gated and skipped by default (it needs a running stack: the gateway, a live interview with Milo in its call, a lead's
// and an admitted guest's realtime tokens). To run it:
//   REAL_GATEWAY_GUEST=1 GATEWAY_WS_URL=ws://localhost:18080/ws IV_CALL_ID=<call id> \
//   IV_LEAD_TOKEN=<lead's realtime token> IV_GUEST_TOKEN=<the admitted guest's realtime token> [IV_LIVE_WINDOW_MS=60000] \
//   npx jest src/lib/__tests__/call-chat-guest.real-gateway.test.ts
// During the live window, have Milo post a notice, approve a question ("Have Milo ask") and let the candidate make both fixed
// requests ("repeat the question", "how much time is left"); the test then compares what each socket received.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import WebSocket from 'ws';
import { callChatChannel } from '../call-chat.js';
import { ASSISTANT_USER_ID } from '../meeting-assistant/chat-types.js';

const enabled = process.env['REAL_GATEWAY_GUEST'] === '1';
const URL = process.env['GATEWAY_WS_URL'] ?? 'ws://localhost:18080/ws';
const CALL = process.env['IV_CALL_ID'] ?? '';
const LIVE_WINDOW_MS = Number(process.env['IV_LIVE_WINDOW_MS'] ?? 60_000);

interface Row { id: string; userId: string; message: string; metadata?: Record<string, unknown> }
type Frame = { type?: string; action?: string; channel?: string; message?: Row; messages?: Row[] } & Record<string, unknown>;
interface Client { ws: WebSocket; frames: Frame[] }

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting for the gateway'); await pause(25); }
}
async function connect(token: string): Promise<Client> {
  const client: Client = { ws: new WebSocket(URL, ['bearer-token-v1', token]), frames: [] };
  client.ws.on('message', (data) => { try { client.frames.push(JSON.parse(String(data)) as Frame); } catch { /* not a frame */ } });
  await until(() => client.frames.some((f) => f.type === 'session'));
  return client;
}
const channel = () => callChatChannel(CALL);
const chatFrames = (c: Client, action: string) => c.frames.filter((f) => f.type === 'chat' && f.channel === channel() && f.action === action);
const history = (c: Client): Row[] => chatFrames(c, 'history').flatMap((f) => f.messages ?? []);
const live = (c: Client): Row[] => [...chatFrames(c, 'message'), ...chatFrames(c, 'messageUpdated')].flatMap((f) => (f.message ? [f.message] : []));
const milo = (rows: Row[]) => rows.filter((r) => r.userId === ASSISTANT_USER_ID);
/** As the panel reads it: an approved question, or an approved answer to a guest's own request. */
const approved = (r: Row): boolean => r.metadata?.['approvedQuestion'] === true
  && (r.metadata?.['approvedAnswer'] !== true || String(r.metadata?.['askedBy'] ?? '').startsWith('guest:'));

(enabled ? describe : describe.skip)('a guest on the real gateway (E9, widened)', () => {
  let lead: Client; let guest: Client;

  beforeAll(async () => {
    if (!CALL || !process.env['IV_LEAD_TOKEN'] || !process.env['IV_GUEST_TOKEN']) throw new Error('IV_CALL_ID, IV_LEAD_TOKEN and IV_GUEST_TOKEN are needed');
    lead = await connect(process.env['IV_LEAD_TOKEN']);
    guest = await connect(process.env['IV_GUEST_TOKEN']);
  }, 30_000);
  afterAll(() => { lead?.ws.close(); guest?.ws.close(); });

  it('the join history: of Milo\'s rows the guest gets only the approved question and the approved answers to its own requests, with no mark or asker', async () => {
    lead.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: channel() }));
    guest.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: channel() }));
    await until(() => chatFrames(lead, 'history').length > 0 && chatFrames(guest, 'history').length > 0);
    const panelMilo = milo(history(lead));
    const allowed = new Set(panelMilo.filter(approved).map((r) => r.id));
    const guestMilo = milo(history(guest));
    for (const r of guestMilo) {
      expect([r.id, allowed.has(r.id)]).toEqual([r.id, true]);
      expect(Object.keys(r.metadata ?? {}).filter((k) => ['kind', 'askedBy', 'askedByName', 'assistant', 'approvedQuestion'].includes(k))).toEqual([]);
    }
    // Everything else of Milo's the panel holds (notices, private replies, cards, minutes) never reached the guest.
    const withheld = panelMilo.filter((r) => !allowed.has(r.id)).map((r) => r.id);
    expect(guestMilo.filter((r) => withheld.includes(r.id))).toEqual([]);
  }, 30_000);

  it('the live frames: during the window the guest gets each approved question and answer the panel gets, and nothing else of Milo\'s', async () => {
    const leadFrom = lead.frames.length; const guestFrom = guest.frames.length;
    await pause(LIVE_WINDOW_MS);
    const panelLive = milo(live({ ...lead, frames: lead.frames.slice(leadFrom) }));
    const guestLive = milo(live({ ...guest, frames: guest.frames.slice(guestFrom) }));
    const allowed = new Set(panelLive.filter(approved).map((r) => r.id));
    expect(guestLive.map((r) => r.id).filter((id) => !allowed.has(id))).toEqual([]);
    expect([...allowed].filter((id) => !guestLive.some((r) => r.id === id))).toEqual([]);
    // The window must have exercised the rule: at least one approved row and one withheld row of Milo's.
    expect(allowed.size).toBeGreaterThan(0);
    expect(panelLive.some((r) => !allowed.has(r.id))).toBe(true);
  }, LIVE_WINDOW_MS + 30_000);
});

if (!enabled) {
  it('is skipped unless REAL_GATEWAY_GUEST=1 (written, not run in the unit suite)', () => { expect(enabled).toBe(false); });
}
