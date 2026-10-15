#!/usr/bin/env node
// Live Social simulator for the local demo (docs/mock-floor.md § "Making Social feel populated").
//
// Logs in a handful of seeded Social users through the normal picker login,
// switches each to the `social` tenant, fetches their realtime token, and holds
// a real /ws connection per user (Sec-WebSocket-Protocol: bearer-token-v1, <jwt>):
// they show up in "Active now" and in the presence of the channels they belong
// to, and every 15-30 min each posts a short off-topic line or a reaction in
// #random (see POST_CHANNELS). Only authorized paths: no fixture is touched.
//
//   node scripts/dev/social-sim.mjs
//   SOCIAL_SIM_BASE=http://127.0.0.1:3001   BFF origin (the gateway is its /ws)
//   SOCIAL_SIM_USERS=u-lena,u-sana,...      who to run (default below)
//
// Do NOT add the account you demo as (u-farah by default) to the cast: switching
// a user's tenant bumps their session epoch, which signs their other browser
// sessions out within ~2 minutes. The default cast avoids u-farah, u-mira,
// u-theo and u-vera for that reason.
//
// Login is limited to 15/min, so users are started 5 s apart. SIGTERM/SIGINT
// close every socket and exit 0.

const BASE = (process.env.SOCIAL_SIM_BASE ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const USERS = (process.env.SOCIAL_SIM_USERS ?? 'u-lena,u-sana,u-asha,u-jonas,u-nora,u-rachel').split(',').map((s) => s.trim()).filter(Boolean);
const LOBBY = 'social:lobby';
const EMOJI = ['👍', '❤️', '😂', '🎉'];

// Demo-quiet by default. The seeded threads (docs/demo-content-audit.md, the
// Social and Work stories) are what a demo reads, so the sim never posts into
// them: text goes only to the off-topic channels in POST_CHANNELS, as short
// timeless lines per person that no seeded thread can contradict, a few an
// hour across the whole cast. Each line is used once; when a person runs out
// they go on reacting. Reactions also stay in POST_CHANNELS. Presence is
// unchanged: everyone still shows as active. SOCIAL_SIM_POST_CHANNELS=slug,slug
// widens it ("" posts nothing).
const POST_CHANNELS = new Set((process.env.SOCIAL_SIM_POST_CHANNELS ?? 'random').split(',').map((s) => s.trim()).filter(Boolean));
const LINES = {
  'u-lena': ['Tea count today: three. I regret nothing.', 'Someone left a very good umbrella in the lobby. It is waiting for you.'],
  'u-sana': ['Current favorite: a podcast about bridges. Yes, bridges.', 'My headset arrived. I can hear myself think, which is mixed news.'],
  'u-asha': ['Ran the loop by the river this morning, the light was ridiculous.', 'Hot take: the best desk plant is the one you forget to water.'],
  'u-jonas': ['Rewatching an old chess documentary. Nothing is as dramatic as a draw.', 'The loud keyboard has a fan club of exactly one.'],
  'u-nora': ['The office plant is on its fourth new leaf. Respect.', 'Small win: my coffee stayed hot until the bottom of the cup.'],
  'u-rachel': ['Lunch idea: leftover noodles with a fried egg. Highly recommended.', 'Spotted a heron by the car park. It looked unbothered.'],
};
const GENERIC = ['Anyone read anything good lately?', 'Cannot recommend the new corner bakery enough.'];
const used = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const log = (id, msg) => console.log(`[social-sim] ${new Date().toISOString().slice(11, 19)} ${id.padEnd(10)} ${msg}`);
let stopping = false;
const bots = [];

function cookieFrom(res, prev = '') {
  const set = res.headers.getSetCookie?.() ?? [];
  const jar = new Map(prev.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
  for (const line of set) { const [pair] = line.split(';'); const [k, v] = pair.split(/=(.*)/s); jar.set(k, v); }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(path, { method = 'GET', cookie = '', body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res;
}

class Bot {
  constructor(id) { this.id = id; this.cookie = ''; this.name = id; this.channels = []; this.ws = null; this.tokenExp = 0; this.messageIds = new Map(); this.timers = new Set(); this.alive = true; }

  async signIn() {
    let res = await api('/api/session/login', { method: 'POST', body: { userId: this.id } });
    if (!res.ok) throw new Error(`login ${res.status}`);
    this.cookie = cookieFrom(res);
    res = await api('/api/session/tenant', { method: 'POST', cookie: this.cookie, body: { tenant: 'social' } });
    if (!res.ok) throw new Error(`tenant switch ${res.status}`);
    this.cookie = cookieFrom(res, this.cookie);
    const me = await (await api('/api/session/me', { cookie: this.cookie })).json().catch(() => ({}));
    this.name = me.name ?? this.id;
  }

  async loadChannels() {
    const res = await api('/api/social/channels', { cookie: this.cookie });
    if (res.status === 401) throw Object.assign(new Error('session expired'), { relogin: true });
    const data = await res.json();
    this.channels = (data.channels ?? []).filter((c) => c.joined).map((c) => ({ channel: c.channel, slug: c.slug }));
  }

  async token() {
    const res = await api('/api/session/realtime-token', { cookie: this.cookie });
    if (res.status === 401) throw Object.assign(new Error('session expired'), { relogin: true });
    if (!res.ok) throw new Error(`token ${res.status}`);
    const { token, expiresAt } = await res.json();
    this.tokenExp = typeof expiresAt === 'number' ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) : Date.parse(expiresAt);
    return token;
  }

  send(frame) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame)); }

  presence() {
    this.send({ service: 'presence', action: 'set', status: 'online', metadata: { displayName: this.name }, channels: [LOBBY, ...this.channels.map((c) => c.channel)] });
  }

  connect(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, ['bearer-token-v1', token]);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.send({ service: 'presence', action: 'subscribe', channel: LOBBY });
        for (const c of this.channels) {
          this.send({ service: 'chat', action: 'join', channel: c.channel });
          this.send({ service: 'chat', action: 'history', channel: c.channel, limit: 30 });
          this.send({ service: 'presence', action: 'subscribe', channel: c.channel });
          this.send({ service: 'reactions', action: 'subscribe', channel: c.channel });
        }
        this.presence();
        resolve();
      };
      ws.onmessage = (ev) => this.onFrame(String(ev.data));
      ws.onerror = () => { if (!opened) reject(new Error('socket error')); };
      ws.onclose = () => { if (!opened) reject(new Error('socket closed before open')); else this.onClosed(); };
    });
  }

  onFrame(raw) {
    let f; try { f = JSON.parse(raw); } catch { return; }
    const remember = (m, channel) => { if (m?.id && channel && !m.deletedAt) { const list = this.messageIds.get(channel) ?? []; if (!list.includes(m.id)) { list.push(m.id); this.messageIds.set(channel, list.slice(-30)); } } };
    if (f.type === 'chat' && Array.isArray(f.messages)) for (const m of f.messages) remember(m, f.channel ?? m.channel);
    else if (f.type === 'chat' && f.message) remember(f.message, f.channel ?? f.message.channel);
  }

  onClosed() { this.ws = null; if (!stopping && this.alive) { log(this.id, 'socket closed, reconnecting'); void this.run(); } }

  later(ms, fn) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); }
  clearTimers() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  act() {
    if (stopping || !this.ws) return;
    const quiet = this.channels.filter((c) => POST_CHANNELS.has(c.slug));
    const c = quiet.length ? pick(quiet) : null;
    const known = c ? this.messageIds.get(c.channel) ?? [] : [];
    if (c && known.length && Math.random() < 0.4) {
      const emoji = pick(EMOJI);
      this.send({ service: 'reactions', action: 'send', channel: c.channel, emoji, targetId: pick(known) });
      log(this.id, `reacted ${emoji} in #${c.slug}`);
    } else if (c) {
      const text = [...(LINES[this.id] ?? GENERIC)].find((t) => !used.has(`${this.id}:${t}`));
      if (text) {
        used.add(`${this.id}:${text}`);
        this.send({ service: 'chat', action: 'send', channel: c.channel, message: text });
        log(this.id, `posted in #${c.slug}: ${text.slice(0, 48)}`);
      }
    }
    // Six people, one action each every 15-30 minutes: roughly 15 an hour at most.
    this.later(15 * 60_000 + Math.random() * 15 * 60_000, () => this.act());
  }

  async run() {
    this.clearTimers();
    for (let attempt = 0; !stopping && this.alive; attempt += 1) {
      try {
        if (!this.cookie) await this.signIn();
        await this.loadChannels();
        const token = await this.token();
        await this.connect(token);
        log(this.id, `online as ${this.name} in ${this.channels.length} channels`);
        this.later(60_000 + Math.random() * 5 * 60_000, () => this.act());
        const heartbeat = () => { this.presence(); this.later(25_000, heartbeat); };
        this.later(25_000, heartbeat);
        // Refresh before the 10-minute token lapses: a new token means a new socket.
        this.later(Math.max(30_000, this.tokenExp - Date.now() - 60_000), () => { log(this.id, 'refreshing token'); this.clearTimers(); const ws = this.ws; this.ws = null; ws?.close(); void this.run(); });
        return;
      } catch (err) {
        if (err.relogin) this.cookie = '';
        const wait = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
        log(this.id, `${err.message}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  }

  stop() { this.alive = false; this.clearTimers(); try { this.ws?.close(); } catch { /* closing */ } }
}

async function main() {
  const health = await api('/api/health').catch(() => null);
  if (!health?.ok) { console.error(`[social-sim] ${BASE} is not answering; start the middleware first`); }
  for (const id of USERS) {
    if (stopping) break;
    const bot = new Bot(id); bots.push(bot);
    void bot.run();
    await sleep(5_000);
  }
}

function shutdown() {
  if (stopping) return; stopping = true;
  console.log('[social-sim] stopping');
  for (const b of bots) b.stop();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
main().catch((err) => { console.error('[social-sim]', err); });
